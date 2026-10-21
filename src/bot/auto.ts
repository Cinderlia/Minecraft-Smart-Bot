import { Bot } from 'mineflayer'
import { ChatHistory } from '../chat/history.js'
import { LlmClient } from '../agent/llm.js'
import { decideNextGoal } from '../agent/autonomic.js'
import { BodyLoop } from '../agent/body.js'
import { Plan } from '../agent/planner.js'
import { Stroll } from './stroll.js'
import { TaskCancelledError } from '../util/async.js'
import { createLogger } from '../util/logger.js'
import { isOwnerOnline } from './world.js'

const log = createLogger('auto')

/** Initial "stand still" window before the first LLM call, and after preemption. */
const FIRST_MIN = 60_000
const FIRST_MAX = 180_000
/** Window between goals once the bot has done one and is strolling. */
const NEXT_MIN = 300_000
const NEXT_MAX = 600_000

function randomDelay(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TaskCancelledError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new TaskCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type GoalTask = { rawRequest: string; plan?: Plan; progress: number }

export class AutoTask {
  private readonly stroll: Stroll
  private strollAbort: AbortController | null = null
  private goalTask: GoalTask | null = null
  /** When the next LLM call is due. Starts as a "stand still" window. */
  private nextTickAt: number
  private stopped = false

  constructor(
    private readonly bot: Bot,
    private readonly llm: LlmClient,
    private readonly body: BodyLoop,
    private readonly history: ChatHistory,
    private readonly owners: string[]
  ) {
    this.stroll = new Stroll(bot)
    this.nextTickAt = Date.now() + randomDelay(FIRST_MIN, FIRST_MAX)
    log.info(`[autonomic] stand still for ${Math.round((this.nextTickAt - Date.now()) / 1000)}s`)
  }

  /** Main autonomic loop. Called by BodyLoop only when the queue is autonomic-only. */
  async run(signal: AbortSignal): Promise<void> {
    if (this.stopped) return
    log.info('[autonomic] running')
    try {
      while (!signal.aborted) {
        // Yield to any player task that arrived.
        if (this.body.queueLength() > 1) {
          this.suspend()
          return
        }

        // No owner online: park. The timer keeps running; no stroll.
        if (!isOwnerOnline(this.bot, this.owners)) {
          this.stopStroll()
          await sleep(1000, signal)
          continue
        }

        // Resume an unfinished goal (kept across preemption).
        if (this.goalTask) {
          this.stopStroll()
          const goal = this.goalTask
          log.info(`[autonomic] resuming goal: ${goal.rawRequest.slice(0, 120)} (progress=${goal.progress})`)
          try {
            await this.body.runSubTask(goal, signal)
          } catch (error) {
            if (error instanceof TaskCancelledError) throw error
            log.warn('[autonomic] goal task failed', error)
          }
          this.goalTask = null
          // After a goal, stroll until the next timer fires.
          this.nextTickAt = Date.now() + randomDelay(NEXT_MIN, NEXT_MAX)
          this.ensureStroll()
          log.info(`[autonomic] goal done; strolling for ${Math.round((this.nextTickAt - Date.now()) / 1000)}s`)
          continue
        }

        // Not yet due: stand still (no stroll before the first LLM call).
        if (Date.now() < this.nextTickAt) {
          this.stopStroll()
          await sleep(1000, signal)
          continue
        }

        // Timer elapsed: stop strolling and ask the LLM.
        this.stopStroll()
        const goal = await decideNextGoal(this.bot, this.llm, this.history)
        if (!goal) {
          // Nothing to do: stroll until the next window.
          this.nextTickAt = Date.now() + randomDelay(NEXT_MIN, NEXT_MAX)
          this.ensureStroll()
          continue
        }
        this.goalTask = { rawRequest: goal, progress: 0 }
        log.info(`[autonomic] decided: ${goal.slice(0, 120)}`)
        // Loop again: next iteration runs the goal.
      }
    } finally {
      this.stopStroll()
    }
  }

  /** Player task preempted us (or shutdown): stop strolling, reset the timer. */
  suspend(): void {
    this.nextTickAt = Date.now() + randomDelay(FIRST_MIN, FIRST_MAX)
    this.stopStroll()
    log.info(`[autonomic] suspended; stand still for ${Math.round((this.nextTickAt - Date.now()) / 1000)}s on resume`)
  }

  stop(): void {
    this.stopped = true
    this.stopStroll()
    this.goalTask = null
  }

  private ensureStroll(): void {
    if (this.stroll.active) return
    this.strollAbort = new AbortController()
    void this.stroll.start(this.strollAbort.signal).catch(error => {
      if (error instanceof TaskCancelledError) return
      log.warn('[autonomic] stroll failed', error)
    })
  }

  private stopStroll(): void {
    this.strollAbort?.abort()
    this.strollAbort = null
    this.stroll.stop()
  }
}