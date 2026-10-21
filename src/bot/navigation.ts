import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskCancelledError, errorMessage, withTimeout } from '../util/async.js'
import { goals } from './goals.js'

export function configureMovements(bot: Bot) {
  bot.ashfinder.config.parkour = true
  bot.ashfinder.config.breakBlocks = false
  bot.ashfinder.config.placeBlocks = false
  bot.ashfinder.config.swimming = true
}

export type NavigateOptions = {
  allowDig?: boolean
  signal: AbortSignal
}

export async function navigate(bot: Bot, goal: goals.Goal, options: NavigateOptions): Promise<void> {
  const allowDig = options.allowDig === true
  const previousBreak = bot.ashfinder.config.breakBlocks
  const previousPlace = bot.ashfinder.config.placeBlocks
  bot.ashfinder.config.breakBlocks = allowDig
  bot.ashfinder.config.placeBlocks = allowDig

  const onAbort = () => bot.ashfinder.stop()
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    // Baritone can silently stall on unreachable goals; cap the wait so the
    // agent loop always gets a result and can retry or give up.
    await withTimeout(
      bot.ashfinder.gotoSmart(goal, { waypointThreshold: 75, forceAdaptive: true }),
      30_000,
      'navigate'
    )
  } catch (error) {
    if (options.signal.aborted) throw new TaskCancelledError()
    throw new Error(`Could not reach destination: ${errorMessage(error)}`)
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    bot.ashfinder.config.breakBlocks = previousBreak
    bot.ashfinder.config.placeBlocks = previousPlace
  }
}

export function goToPosition(bot: Bot, pos: Vec3, range: number, options: NavigateOptions) {
  return navigate(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), options)
}

export function goToBlock(bot: Bot, pos: Vec3, options: NavigateOptions) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4) return Promise.resolve()
  return navigate(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), options)
}

export function stopAllMovement(bot: Bot) {
  if (!bot.entity) return
  bot.ashfinder.stop()
  bot.clearControlStates()
  bot.stopDigging()
}