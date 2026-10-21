import { Bot } from 'mineflayer'
import { Config } from '../config.js'
import { ToolRegistry } from '../tools/registry.js'
import { createLogger } from '../util/logger.js'
import { TaskCancelledError } from '../util/async.js'
import { ChatSpeaker } from './chat.js'
import { LlmClient } from './llm.js'
import { Plan, PlannedTask, planTask } from './planner.js'
import { verifyTask } from './verifier.js'
import { buildSystemPrompt, buildUserMessage, renderGuideSections } from './prompt.js'
import { describeWorldState } from '../bot/status.js'
import { stopAllMovement } from '../bot/navigation.js'

const log = createLogger('body')

export type TaskPriority = number // higher = more urgent

export type QueuedTask = {
  id: string
  rawRequest: string
  username: string
  priority: TaskPriority
  /** Index of the next planned step to run (0 = not started). */
  progress: number
  plan?: Plan
  controller?: AbortController
  state: 'queued' | 'running' | 'suspended' | 'done' | 'failed' | 'cancelled'
}

const AUTONOMIC_TASK_ID = '__autonomic__'
const AUTONOMIC_PRIORITY = Number.MIN_SAFE_INTEGER

export class BodyLoop {
  private queue: QueuedTask[] = []
  private current: QueuedTask | null = null
  private preempt = false
  private running = false

  constructor(
    private readonly bot: Bot,
    private readonly registry: ToolRegistry,
    private readonly llm: LlmClient,
    private readonly config: Config['agent'],
    private readonly speaker?: ChatSpeaker
  ) {
    this.queue.push({
      id: AUTONOMIC_TASK_ID,
      rawRequest: 'autonomic',
      username: 'self',
      priority: AUTONOMIC_PRIORITY,
      progress: 0,
      state: 'queued'
    })
  }

  snapshot(): {
    current: { id: string; request: string; progress: number } | null
    queued: { id: string; request: string; priority: number; progress: number }[]
  } {
    return {
      current: this.current && this.current.id !== AUTONOMIC_TASK_ID
        ? { id: this.current.id, request: this.current.rawRequest, progress: this.current.progress }
        : null,
      queued: this.queue
        .filter(t => t.id !== AUTONOMIC_TASK_ID)
        .map(t => ({ id: t.id, request: t.rawRequest, priority: t.priority, progress: t.progress }))
    }
  }

  get busy(): boolean {
    return this.current !== null && this.current.id !== AUTONOMIC_TASK_ID
  }

  currentTaskDescription(): string | null {
    if (!this.current || this.current.id === AUTONOMIC_TASK_ID) return null
    const t = this.current
    if (t.plan && t.progress < t.plan.tasks.length) return t.plan.tasks[t.progress].description
    return t.rawRequest
  }

  enqueue(request: { username: string; message: string; priority?: TaskPriority }): string {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const task: QueuedTask = {
      id,
      rawRequest: request.message,
      username: request.username,
      priority: request.priority ?? 0,
      progress: 0,
      state: 'queued'
    }
    this.queue.push(task)
    this.sortQueue()
    log.info(`[task ${id}] enqueued p=${task.priority} from ${request.username}: ${request.message}`)
    this.preempt = true
    void this.pump()
    return id
  }

  cancel(id: string): boolean {
    if (id === AUTONOMIC_TASK_ID) return false
    const idx = this.queue.findIndex(t => t.id === id)
    if (idx === -1) return false
    const [task] = this.queue.splice(idx, 1)
    task.state = 'cancelled'
    if (this.current?.id === id) this.current.controller?.abort()
    log.info(`[task ${id}] cancelled`)
    this.preempt = true
    void this.pump()
    return true
  }

  setPriority(id: string, priority: TaskPriority): boolean {
    const task = this.queue.find(t => t.id === id)
    if (!task || task.id === AUTONOMIC_TASK_ID) return false
    task.priority = priority
    this.sortQueue()
    log.info(`[task ${id}] priority → ${priority}`)
    this.preempt = true
    void this.pump()
    return true
  }

  cancelAll(): void {
    this.queue = this.queue.filter(t => t.id === AUTONOMIC_TASK_ID)
    this.current?.controller?.abort()
    this.current = null
    stopAllMovement(this.bot)
  }

  private sortQueue() {
    this.queue.sort((a, b) => {
      if (a.id === AUTONOMIC_TASK_ID) return 1
      if (b.id === AUTONOMIC_TASK_ID) return -1
      return b.priority - a.priority
    })
  }
  private lastAutonomicLog = 0
  private async pump() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        this.preempt = false
        const head = this.queue[0]
        this.current = head

        // 在 pump 的 autonomic 分支里
        if (head.id === AUTONOMIC_TASK_ID) {
            this.current = null
            const now = Date.now()
            if (now - this.lastAutonomicLog > 60_000) {
                this.lastAutonomicLog = now
                log.info(`[autonomic] idle — no tasks queued, running self-maintenance tick`)
            }
            await new Promise(r => setTimeout(r, 500))
            continue
        }

        head.state = 'running'
        head.controller = new AbortController()
        log.info(`[task ${head.id}] running "${head.rawRequest}" (progress=${head.progress})`)
        try {
          await this.runTaskItem(head)
          head.state = 'done'
        } catch (error) {
          if (error instanceof TaskCancelledError) {
            head.state = head.state === 'suspended' ? 'suspended' : 'cancelled'
          } else {
            log.error(`[task ${head.id}] failed`, error)
            head.state = 'failed'
          }
        } finally {
          head.controller = undefined
          this.current = null
          if (head.state === 'done' || head.state === 'failed' || head.state === 'cancelled') {
            const idx = this.queue.findIndex(t => t.id === head.id)
            if (idx !== -1) this.queue.splice(idx, 1)
            log.info(`[task ${head.id}] removed (state=${head.state})`)
          } else if (head.state === 'suspended') {
            log.info(`[task ${head.id}] suspended at step ${head.progress}/${head.plan?.tasks.length ?? '?'}`)
            head.state = 'queued'
            this.sortQueue()
          }
        }
      }
    } finally {
      this.running = false
    }
  }

  private async runTaskItem(task: QueuedTask): Promise<void> {
    if (!task.plan) {
      task.plan = await planTask(this.bot, this.llm, this.registry, { username: task.username, message: task.rawRequest })
      log.info(`[task ${task.id}] plan: ${task.plan.goal} — ${task.plan.tasks.length} step(s)`)
      for (const s of task.plan.tasks) {
        log.info(`  [task ${task.id} step ${s.id}] deps=[${s.depends_on.join(',')}] ${s.description}`)
      }
    }

    const plan = task.plan
    const signal = task.controller!.signal
    const results = new Map<number, string>()

    for (let i = 0; i < task.progress; i++) {
      results.set(plan.tasks[i].id, '(completed earlier)')
    }

    const remaining = new Map(plan.tasks.filter((_, i) => i >= task.progress).map(s => [s.id, s]))

    while (remaining.size > 0) {
      if (signal.aborted) throw new TaskCancelledError()
      const ready = [...remaining.values()].filter(s => s.depends_on.every(dep => results.has(dep)))
      if (ready.length === 0) {
        log.error(`[task ${task.id}] unresolved deps`)
        task.state = 'failed'
        throw new Error('unresolved dependencies')
      }
      ready.sort((a, b) => a.id - b.id)
      for (const planned of ready) {
        if (signal.aborted) throw new TaskCancelledError()

        if (this.preempt) {
          const newHead = this.queue[0]
          if (newHead && newHead.id !== task.id) {
            log.info(`[task ${task.id}] preempted by ${newHead.id}; suspending at step ${task.progress}`)
            task.state = 'suspended'
            throw new TaskCancelledError()
          }
        }

        const plannedIndex = plan.tasks.findIndex(s => s.id === planned.id)
        log.info(`--- [task ${task.id} step ${planned.id}] ${planned.description}`)
        const outcome = await this.runPlannedStep(planned, task, signal)
        results.set(planned.id, outcome)
        remaining.delete(planned.id)
        task.progress = Math.max(task.progress, plannedIndex + 1)
        log.info(`--- [task ${task.id} step ${planned.id}] result: ${outcome.slice(0, 160)} (progress=${task.progress}/${plan.tasks.length})`)

        if (outcome.startsWith('failed') || outcome.startsWith('needs_revision (gave up')) {
          log.warn(`[task ${task.id} step ${planned.id}] hard-failed: ${outcome}`)
          task.state = 'failed'
          throw new Error(`step failed: ${outcome}`)
        }
      }
    }

    const summary = plan.tasks.map(s => `[${s.id}] ${results.get(s.id) ?? 'skipped'}`).join(' | ').slice(0, 240)
    log.info(`[task ${task.id}] summary: ${summary}`)
    if (this.speaker) {
      const ok = [...results.values()].filter(r => !r.startsWith('failed') && !r.startsWith('partial') && !r.startsWith('needs_revision')).length
      this.speaker.speak(task.rawRequest, {
        busyWith: null,
        report: plan.tasks.length <= 1 ? summary : `${ok}/${plan.tasks.length} 步完成。${summary}`
      })
    }
  }

  private async runPlannedStep(step: PlannedTask, parent: QueuedTask, signal: AbortSignal, depth = 0): Promise<string> {
    const executePrompt = buildSystemPrompt(this.bot.username, this.registry, renderGuideSections(step.guide_sections))
    let searchTarget: string | null = null
    const stepText = `${step.description}\n\nDone when: ${step.done_when}${step.needs.length > 0 ? `\nItems needed: ${step.needs.join(', ')}` : ''}`
    const userMessage = { role: 'user' as const, content: buildUserMessage(parent.username, stepText, describeWorldState(this.bot, searchTarget)) }
    const messages = [{ role: 'system' as const, content: executePrompt }, userMessage]
    const tools = this.registry.toOllamaTools()
    const ctx = { bot: this.bot, signal, log, requester: parent.username }
    const toolLog: string[] = []
    let reply = ''
    let turn = 0
    const maxTurns = 15

    for (; turn < maxTurns; turn++) {
      userMessage.content = buildUserMessage(parent.username, stepText, describeWorldState(this.bot, searchTarget))
      const response = await this.llm.chat(messages, tools)
      if (signal.aborted) throw new TaskCancelledError()
      messages.push(response)
      const calls = response.tool_calls ?? []
      if (calls.length === 0) {
        reply = response.content.trim()
        log.info(`[task ${parent.id} step ${step.id} turn ${turn}] model final reply: ${reply.slice(0, 160)}`)
        break
      }
      for (const call of calls) {
        const name = call.function.name
        if (name === 'select_guide') {
          messages.push({ role: 'tool', tool_name: name, content: `Guide sections are fixed by the planner: ${step.guide_sections.join(', ') || 'none'}.` } as any)
          continue
        }
        const args = (call.function.arguments ?? {}) as Record<string, unknown>
        if (['find_blocks', 'collect_block', 'go_to_block', 'find_block_cells'].includes(name) && typeof args.block === 'string') {
          searchTarget = String(args.block)
        }
        log.info(`[task ${parent.id} step ${step.id} turn ${turn}] → ${name} ${JSON.stringify(call.function.arguments)}`)
        const started = Date.now()
        const outcome = await this.registry.execute({ name, arguments: call.function.arguments }, ctx)
        const took = ((Date.now() - started) / 1000).toFixed(1)
        const output = outcome.output.length > 2000 ? `${outcome.output.slice(0, 2000)}…` : outcome.output
        log.info(`[task ${parent.id} step ${step.id} turn ${turn}] ${outcome.ok ? '✓' : '✗'} ${name} (${took}s): ${output.split('\n')[0]}`)
        toolLog.push(`${outcome.ok ? '✓' : '✗'} ${name} ${JSON.stringify(call.function.arguments)}: ${output.split('\n')[0]}`)
        messages.push({ role: 'tool', tool_name: name, content: output } as any)
      }
    }

    if (turn >= maxTurns && !reply) {
      reply = `stopped after ${maxTurns} turns`
      log.info(`[task ${parent.id} step ${step.id}] hit maxTurns without a final reply`)
    }

    if (signal.aborted) throw new TaskCancelledError()

    log.info(`[task ${parent.id} step ${step.id}] verifying...`)
    let verdict
    try {
      verdict = await verifyTask(this.bot, this.llm, step, { username: parent.username, message: parent.rawRequest }, toolLog)
    } catch {
      return reply || 'done (unverified)'
    }
    log.info(`[task ${parent.id} step ${step.id}] verdict: ${verdict.status} — ${verdict.reason.slice(0, 200)}`)

    if (verdict.status === 'done') return verdict.reason || reply || 'done'
    if (verdict.status === 'partial') {
      if (depth >= 2) return `partial: ${verdict.reason}`
      log.info(`[task ${parent.id} step ${step.id}] partial, retrying (depth ${depth + 1}/2)`)
      return this.runPlannedStep({ ...step, description: `${step.description}\n\nPartial: ${verdict.reason}` }, parent, signal, depth + 1)
    }
    if (verdict.status === 'failed') return `failed: ${verdict.reason}`
    if (!verdict.revised_task) return `needs_revision: ${verdict.reason}`
    if (depth >= 2) return `needs_revision (gave up): ${verdict.reason}`
    log.info(`[task ${parent.id} step ${step.id}] revised (depth ${depth + 1}/2): ${verdict.revised_task.description?.slice(0, 120) ?? ''}`)
    return this.runPlannedStep({ ...step, description: verdict.revised_task.description ?? step.description, done_when: verdict.revised_task.done_when ?? step.done_when }, parent, signal, depth + 1)
  }
}