import { Bot } from 'mineflayer'
import { stopAllMovement } from '../bot/navigation.js'
import { describeWorldState } from '../bot/status.js'
import { Config } from '../config.js'
import { ToolRegistry } from '../tools/registry.js'
import { TaskCancelledError, errorMessage } from '../util/async.js'
import { createLogger } from '../util/logger.js'
import { LlmClient, Message } from './llm.js'
import { Plan, PlannedTask, planTask } from './planner.js'
import { buildSystemPrompt, buildUserMessage, renderGuideSections } from './prompt.js'

const log = createLogger('agent')
const maxToolOutput = 2000
const historyTurns = 6
/** Max LLM steps allowed per planned task, before the loop is cut. */
const maxStepsPerTask = 15

/** Tools whose `block` argument sets the active search target for surroundings. */
const SEARCH_TOOLS = new Set(['find_blocks', 'collect_block', 'go_to_block', 'find_block_cells'])

export type AgentRequest = { username: string; message: string }

export class Agent {
  private readonly queue: AgentRequest[] = []
  private readonly history: Message[] = []
  private controller: AbortController | null = null

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

    let plan: Plan
    try {
      plan = await planTask(this.bot, this.llm, this.registry, request)
    } catch (error) {
      if (signal.aborted) throw new TaskCancelledError()
      log.error('Planner failed', error)
      this.bot.chat(`Could not plan that: ${errorMessage(error).slice(0, 120)}`)
      this.remember(request, '')
      return
    }

    log.info(`Plan: ${plan.goal} — ${plan.tasks.length} task(s)`)
    for (const t of plan.tasks) {
      log.info(`  [${t.id}] ${t.description} | done_when: ${t.done_when} | needs: ${t.needs.join(', ') || '-'}`)
    }

    const results: string[] = []
    for (const task of plan.tasks) {
      if (signal.aborted) throw new TaskCancelledError()
      log.info(`--- Task ${task.id}: ${task.description}`)
      const outcome = await this.runTask(task, request, signal)
      results.push(`[${task.id}] ${outcome}`)
    }

    const summary = results.length > 0 ? results.join(' | ').slice(0, 240) : 'Done.'
    this.bot.chat(summary)
    this.remember(request, summary)
  }

  /** Execute a single planned task with the standard tool loop. */
  private async runTask(task: PlannedTask, request: AgentRequest, signal: AbortSignal): Promise<string> {
    const executePrompt = buildSystemPrompt(
      this.bot.username,
      this.registry,
      renderGuideSections(task.guide_sections)
    )

    let searchTarget: string | null = null
    const taskText = `${task.description}\n\nDone when: ${task.done_when}${task.needs.length > 0 ? `\nItems needed: ${task.needs.join(', ')}` : ''}`
    const userMessage: Message = {
      role: 'user',
      content: buildUserMessage(request.username, taskText, describeWorldState(this.bot, searchTarget))
    }
    const messages: Message[] = [
      { role: 'system', content: executePrompt },
      ...this.history,
      userMessage
    ]
    const tools = this.registry.toOllamaTools()
    const ctx = { bot: this.bot, signal, log, requester: request.username }

    let reply = ''
    let step = 0

    for (; step < maxStepsPerTask; step++) {
      // Refresh the user message so the model sees current surroundings each turn.
      userMessage.content = buildUserMessage(
        request.username,
        taskText,
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
          // Planner already chose guide sections; ignore stray select_guide calls.
          messages.push({
            role: 'tool',
            tool_name: name,
            content: `Guide sections are fixed by the planner: ${task.guide_sections.join(', ') || 'none'}.`
          })
          continue
        }

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

    if (step >= maxStepsPerTask && !reply) {
      reply = `stopped after ${maxStepsPerTask} steps`
      log.info(`Task ${task.id} hit maxStepsPerTask without a final reply`)
    }
    return reply || 'done'
  }

  private remember(request: AgentRequest, reply: string) {
    this.history.push(
      { role: 'user', content: `${request.username} says: ${request.message}` },
      { role: 'assistant', content: reply || '(done)' }
    )
    while (this.history.length > historyTurns * 2) this.history.shift()
  }
}