import { Bot } from 'mineflayer'
import { stopAllMovement } from '../bot/navigation.js'
import { Config } from '../config.js'
import { ToolRegistry } from '../tools/registry.js'
import { TaskCancelledError, errorMessage } from '../util/async.js'
import { createLogger } from '../util/logger.js'
import { LlmClient, Message } from './llm.js'
import { buildSystemPrompt, buildUserMessage, guideCatalog, renderGuideSections } from './prompt.js'
import { describeSurroundings, describeWorldState } from '../bot/status.js'

const log = createLogger('agent')
const maxToolOutput = 2000
const historyTurns = 6

/** Tools whose `block` argument sets the active search target for surroundings. */
const SEARCH_TOOLS = new Set(['find_blocks', 'collect_block', 'go_to_block'])

export type AgentRequest = { username: string; message: string }

export class Agent {
  private readonly queue: AgentRequest[] = []
  private readonly history: Message[] = []
  private controller: AbortController | null = null
  /** Selection-stage prompt: rules + catalog + guide heading list, no guide bodies. */
  private selectPrompt: string | null = null

  constructor(
    private readonly bot: Bot,
    private readonly registry: ToolRegistry,
    private readonly llm: LlmClient,
    private readonly config: Config['agent']
  ) {}

  get busy(): boolean {
    return this.controller !== null
  }

  submit(request: AgentRequest) {
    this.queue.push(request)
    if (this.busy) {
      this.bot.chat(`Queued (${this.queue.length} waiting). Say "stop" to cancel the current task.`)
      return
    }
    void this.drain()
  }

  cancel(): boolean {
    const hadWork = this.busy || this.queue.length > 0
    this.queue.length = 0
    this.controller?.abort()
    this.llm.abort()
    stopAllMovement(this.bot)
    return hadWork
  }

  private async drain() {
    while (this.queue.length > 0) {
      const request = this.queue.shift()!
      this.controller = new AbortController()
      try {
        await this.run(request, this.controller.signal)
      } catch (error) {
        if (error instanceof TaskCancelledError || this.controller.signal.aborted) {
          log.info('Task cancelled')
        } else {
          log.error('Agent error', error)
          this.bot.chat(`Something went wrong: ${errorMessage(error).slice(0, 120)}`)
        }
      } finally {
        this.controller = null
      }
    }
  }

  private async run(request: AgentRequest, signal: AbortSignal) {
    log.info(`${request.username}: ${request.message}`)
    this.selectPrompt ??= buildSystemPrompt(this.bot.username, this.registry, guideCatalog())

    let searchTarget: string | null = null
    const userMessage: Message = {
      role: 'user',
      content: buildUserMessage(request.username, request.message, describeWorldState(this.bot, searchTarget))
    }
    const messages: Message[] = [
      { role: 'system', content: this.selectPrompt },
      ...this.history,
      userMessage
    ]
    const tools = this.registry.toOllamaTools()
    const ctx = { bot: this.bot, signal, log, requester: request.username }

    let chosenSections: string[] = []
    let reply = ''
    let step = 0
    let switched = false

    for (; step < this.config.maxSteps; step++) {
      if (step === 1 && !switched) {
        const executePrompt = buildSystemPrompt(
          this.bot.username,
          this.registry,
          renderGuideSections(chosenSections)
        )
        messages[0] = { role: 'system', content: executePrompt }
        switched = true
        log.info(`Guide sections loaded: ${chosenSections.join(', ') || 'FULL (model did not call select_guide)'}`)
      }

      // Refresh the user message so the model sees current surroundings every turn.
      userMessage.content = buildUserMessage(
        request.username,
        request.message,
        describeWorldState(this.bot, searchTarget)
      )

      const response = await this.llm.chat(messages, tools)
      if (signal.aborted) throw new TaskCancelledError()
      messages.push(response)

      const calls = response.tool_calls ?? []
      if (calls.length === 0) {
        reply = response.content.trim()
        break
      }

      for (const call of calls) {
        const name = call.function.name
        if (name === 'select_guide') {
          const raw = String((call.function.arguments as any)?.sections ?? '')
          chosenSections = raw.split(',').map(s => s.trim()).filter(Boolean)
          log.info(`LLM selected guide sections: ${chosenSections.join(', ') || '(none)'}`)
          messages.push({
            role: 'tool',
            tool_name: name,
            content: `Loaded guide sections: ${chosenSections.join(', ') || '(none — full guide will be used)'}`
          })
          continue
        }

        // Track the active search target so surroundings include the nearest blocks.
        const args = (call.function.arguments ?? {}) as Record<string, unknown>
        if (SEARCH_TOOLS.has(name) && typeof args.block === 'string' && args.block.trim()) {
          searchTarget = args.block.trim()
        }

        log.info(`→ ${name} ${JSON.stringify(call.function.arguments)}`)
        const started = Date.now()
        const outcome = await this.registry.execute({ name, arguments: call.function.arguments }, ctx)
        const took = ((Date.now() - started) / 1000).toFixed(1)
        const output = outcome.output.length > maxToolOutput ? `${outcome.output.slice(0, maxToolOutput)}… (truncated)` : outcome.output
        log.info(`${outcome.ok ? '✓' : '✗'} ${name} (${took}s): ${output.split('\n')[0]}`)
        messages.push({ role: 'tool', tool_name: name, content: output })
      }
    }

    if (step >= this.config.maxSteps) {
      reply = `I stopped after ${this.config.maxSteps} steps without finishing. Tell me how to continue.`
    }
    if (reply) this.bot.chat(reply.slice(0, 256))
    this.remember(request, reply)
  }

  private remember(request: AgentRequest, reply: string) {
    this.history.push(
      { role: 'user', content: `${request.username} says: ${request.message}` },
      { role: 'assistant', content: reply || '(done)' }
    )
    while (this.history.length > historyTurns * 2) this.history.shift()
  }
}