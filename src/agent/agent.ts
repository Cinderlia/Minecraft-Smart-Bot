import { Bot } from 'mineflayer'
import { stopAllMovement } from '../bot/navigation.js'
import { describeWorldState } from '../bot/status.js'
import { Config } from '../config.js'
import { ToolRegistry } from '../tools/registry.js'
import { TaskCancelledError, errorMessage } from '../util/async.js'
import { createLogger } from '../util/logger.js'
import { ChatSpeaker } from './chat.js'
import { LlmClient, Message } from './llm.js'
import { Plan, PlannedTask, planTask } from './planner.js'
import { Verdict, verifyTask } from './verifier.js'
import { buildSystemPrompt, buildUserMessage, renderGuideSections } from './prompt.js'

const log = createLogger('agent')
const maxToolOutput = 2000
const historyTurns = 6
/** Max LLM steps allowed per planned task, before the loop is cut. */
const maxStepsPerTask = 15
/** Max times a single task may be retried after a needs_revision verdict. */
const maxRevisions = 2

/** Tools whose `block` argument sets the active search target for surroundings. */
const SEARCH_TOOLS = new Set(['find_blocks', 'collect_block', 'go_to_block', 'find_block_cells'])

export type AgentRequest = { username: string; message: string }

export class Agent {
  private readonly queue: AgentRequest[] = []
  private readonly history: Message[] = []
  private controller: AbortController | null = null
  /** Human-readable description of the task currently running, for chat context. */
  private currentTaskText: string | null = null

  constructor(
    private readonly bot: Bot,
    private readonly registry: ToolRegistry,
    private readonly llm: LlmClient,
    private readonly config: Config['agent'],
    private readonly speaker?: ChatSpeaker
  ) {}

  get busy(): boolean {
    return this.controller !== null
  }

  /** What the agent is doing right now, in plain words, or null when idle. */
  currentTaskDescription(): string | null {
    return this.currentTaskText
  }

  submit(request: AgentRequest) {
    this.queue.push(request)
    if (this.busy) {
      // Never announce queue status in chat from here; the caller routes it through ChatSpeaker.
      log.info(`Queued (${this.queue.length} waiting): ${request.message}`)
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
    this.currentTaskText = null
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
          // Report failures through the speaker when available, never raw logs.
          if (this.speaker) this.speaker.speak(request.message, { busyWith: null, report: `Something went wrong: ${errorMessage(error).slice(0, 120)}` })
          else this.bot.chat(`Something went wrong: ${errorMessage(error).slice(0, 120)}`)
        }
      } finally {
        this.controller = null
        this.currentTaskText = null
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
      if (this.speaker) this.speaker.speak(request.message, { busyWith: null, report: `Could not plan that: ${errorMessage(error).slice(0, 120)}` })
      else this.bot.chat(`Could not plan that: ${errorMessage(error).slice(0, 120)}`)
      this.remember(request, '')
      return
    }

    log.info(`Plan: ${plan.goal} — ${plan.tasks.length} task(s)`)
    for (const t of plan.tasks) {
      log.info(`  [${t.id}] deps=[${t.depends_on.join(',')}] ${t.description} | done_when: ${t.done_when} | needs: ${t.needs.join(', ') || '-'}`)
    }

    const results = new Map<number, string>()
    const remaining = new Map(plan.tasks.map(t => [t.id, t]))

    while (remaining.size > 0) {
      if (signal.aborted) throw new TaskCancelledError()

      const ready = [...remaining.values()].filter(t => t.depends_on.every(dep => results.has(dep)))
      if (ready.length === 0) {
        log.error(`Plan has unresolved dependencies: ${[...remaining.keys()].join(',')}`)
        break
      }

      // The bot acts on one thing at a time, so run ready tasks sequentially in plan order.
      ready.sort((a, b) => a.id - b.id)
      for (const task of ready) {
        if (signal.aborted) throw new TaskCancelledError()
        log.info(`--- Task ${task.id}: ${task.description}`)
        this.currentTaskText = task.description
        const outcome = await this.runTask(task, request, signal)
        results.set(task.id, outcome)
        remaining.delete(task.id)
      }
    }

    const summary = plan.tasks
      .map(t => `[${t.id}] ${results.get(t.id) ?? 'skipped'}`)
      .join(' | ')
      .slice(0, 240)

    // Plans and step lists stay in the log; the human-facing summary goes through the speaker.
    log.info(`Plan summary: ${summary}`)
    if (this.speaker) {
      const ok = [...results.values()].filter(r => !r.startsWith('failed') && !r.startsWith('partial') && !r.startsWith('needs_revision')).length
      this.speaker.speak(request.message, {
        busyWith: null,
        report: plan.tasks.length <= 1 ? summary : `${ok}/${plan.tasks.length} steps finished. ${summary}`
      })
    } else {
      this.bot.chat(summary || 'Done.')
    }
    this.remember(request, summary)
  }

  /** Execute a single planned task with the tool loop, then verify and possibly revise. */
  private async runTask(
    task: PlannedTask,
    request: AgentRequest,
    signal: AbortSignal,
    depth = 0
  ): Promise<string> {
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

    const toolLog: string[] = []
    let reply = ''
    let step = 0

    for (; step < maxStepsPerTask; step++) {
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

        toolLog.push(`${outcome.ok ? '✓' : '✗'} ${name} ${JSON.stringify(call.function.arguments)}: ${output.split('\n')[0]}`)
        messages.push({ role: 'tool', tool_name: name, content: output })
      }
    }

    if (step >= maxStepsPerTask && !reply) {
      reply = `stopped after ${maxStepsPerTask} steps`
      log.info(`Task ${task.id} hit maxStepsPerTask without a final reply`)
    }

    if (signal.aborted) throw new TaskCancelledError()

    let verdict: Verdict
    try {
      verdict = await verifyTask(this.bot, this.llm, task, request, toolLog)
    } catch (error) {
      if (signal.aborted) throw new TaskCancelledError()
      log.warn(`Verifier failed for task ${task.id}: ${errorMessage(error)}`)
      return reply || 'done (unverified)'
    }

    log.info(`Task ${task.id} verdict: ${verdict.status} — ${verdict.reason}`)

    if (verdict.status === 'done') {
      return verdict.reason || reply || 'done'
    }
    if (verdict.status === 'partial') {
      if (depth >= maxRevisions) {
        return `partial (gave up after ${maxRevisions} retries): ${verdict.reason}`
      }
      log.info(`Task ${task.id} partial, retrying with hint: ${verdict.reason}`)
      return this.runTask(
        { ...task, description: `${task.description}\n\nPrevious attempt was partial: ${verdict.reason}\nAddress the missing part before finishing.` },
        request,
        signal,
        depth + 1
      )
    }
    if (verdict.status === 'failed') {
      return `failed: ${verdict.reason}`
    }
    // needs_revision
    if (!verdict.revised_task) {
      return `needs_revision (no revised task): ${verdict.reason}`
    }
    if (depth >= maxRevisions) {
      return `needs_revision (gave up after ${maxRevisions} revisions): ${verdict.reason}`
    }

    const revised: PlannedTask = {
      ...task,
      description: verdict.revised_task.description ?? task.description,
      done_when: verdict.revised_task.done_when ?? task.done_when,
      needs: verdict.revised_task.needs ?? task.needs,
      guide_sections: verdict.revised_task.guide_sections ?? task.guide_sections
    }
    log.info(`Task ${task.id} revised (depth ${depth + 1}/${maxRevisions}): ${revised.description}`)
    return this.runTask(revised, request, signal, depth + 1)
  }

  private remember(request: AgentRequest, reply: string) {
    this.history.push(
      { role: 'user', content: `${request.username} says: ${request.message}` },
      { role: 'assistant', content: reply || '(done)' }
    )
    while (this.history.length > historyTurns * 2) this.history.shift()
  }
}