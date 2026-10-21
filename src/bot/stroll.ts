import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createLogger } from '../util/logger.js'
import { goals } from './goals.js'
import { navigate } from './navigation.js'
import { TaskCancelledError } from '../util/async.js'

const log = createLogger('stroll')

const SEARCH_RADIUS = 128
const MAX_HEIGHT_DIFF = 10
const MAX_ATTEMPTS = 20
/** Higher dig cost so pathfinding prefers walking around rather than tunnelling. */
const STROLL_DIG_COST = 12

/**
 * Pick a random standable cell within SEARCH_RADIUS whose height is within
 * MAX_HEIGHT_DIFF of the bot. Returns null if no candidate passes.
 */
function pickStrollTarget(bot: Bot): Vec3 | null {
  const origin = bot.entity.position.floored()
  // findBlocks with a custom matcher is broad; instead sample random cells and
  // test them, which is cheaper than scanning the whole volume.
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const dx = Math.floor(Math.random() * (SEARCH_RADIUS * 2 + 1)) - SEARCH_RADIUS
    const dz = Math.floor(Math.random() * (SEARCH_RADIUS * 2 + 1)) - SEARCH_RADIUS
    const x = origin.x + dx
    const z = origin.z + dz
    // Probe the column around the bot's y for a standable cell.
    for (let dy = -MAX_HEIGHT_DIFF; dy <= MAX_HEIGHT_DIFF; dy++) {
      const y = origin.y + dy
      const below = bot.blockAt(new Vec3(x, y - 1, z))
      const feet = bot.blockAt(new Vec3(x, y, z))
      const head = bot.blockAt(new Vec3(x, y + 1, z))
      if (!below || !feet || !head) continue
      if (below.boundingBox !== 'block') continue
      if (feet.boundingBox !== 'empty' && feet.name !== 'water') continue
      if (head.boundingBox !== 'empty' && head.name !== 'water') continue
      return new Vec3(x, y, z)
    }
  }
  return null
}

/**
 * Stroll loop: pick a random reachable target, walk there, then pick another.
 * Runs until `stop()` is called or the signal aborts.
 */
export class Stroll {
  private controller: AbortController | null = null
  private running = false

  constructor(private readonly bot: Bot) {}

  get active(): boolean {
    return this.running
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    const inner = this.controller.signal
    const combined = anySignal([signal, inner])

    try {
      while (!combined.aborted) {
        const target = pickStrollTarget(this.bot)
        if (!target) {
          log.warn('no stroll target found; waiting')
          await sleep(2000, combined)
          continue
        }
        log.info(`strolling to ${target.x}, ${target.y}, ${target.z}`)
        try {
          await navigateWithDigCost(this.bot, target, combined)
          await sleep(1500, combined) // small pause, then pick another target
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          log.debug('stroll target failed; picking another', error)
        }
      }
    } finally {
      this.running = false
      this.controller = null
    }
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.running = false
  }
}

/** navigate() wrapper that bumps dig cost so the bot prefers walking around. */
async function navigateWithDigCost(bot: Bot, target: Vec3, signal: AbortSignal): Promise<void> {
  const previous = (bot.ashfinder.config as any).breakBlocksCost
  try {
    ;(bot.ashfinder.config as any).breakBlocksCost = STROLL_DIG_COST
  } catch {
    /* config field may not exist on this version */
  }
  try {
    await navigate(bot, new goals.GoalNear(target.x, target.y, target.z, 1), { signal })
  } finally {
    try {
      ;(bot.ashfinder.config as any).breakBlocksCost = previous
    } catch {
      /* ignore */
    }
  }
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

/** Minimal anySignal implementation (some tsconfigs lack the lib helper). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort()
      break
    }
    s.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}