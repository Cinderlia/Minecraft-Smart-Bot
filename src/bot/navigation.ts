import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { TaskCancelledError, errorMessage } from '../util/async.js'
import { goals } from './goals.js'

/**
 * Travel by default never breaks blocks, so the bot walks around builds.
 * Only tasks that explicitly need to dig through terrain (collect_block,
 * go_to_block on a buried target) opt in with allowDig: true.
 */
export function configureMovements(bot: Bot) {
  // Baritone config is global; navigate() toggles breakBlocks per call.
  bot.ashfinder.config.parkour = true
  bot.ashfinder.config.breakBlocks = false
  bot.ashfinder.config.placeBlocks = false
  bot.ashfinder.config.swimming = true
}

export type NavigateOptions = {
  /** Allow digging through blocks on the way. Default false. */
  allowDig?: boolean
  signal: AbortSignal
}

export async function navigate(bot: Bot, goal: goals.Goal, options: NavigateOptions): Promise<void> {
  const allowDig = options.allowDig === true
  const previousBreak = bot.ashfinder.config.breakBlocks
  const previousPlace = bot.ashfinder.config.placeBlocks
  bot.ashfinder.config.breakBlocks = allowDig
  // Only let it pillar/bridge when digging is allowed; otherwise stay on solid ground.
  bot.ashfinder.config.placeBlocks = allowDig

  const onAbort = () => bot.ashfinder.stop()
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await bot.ashfinder.gotoSmart(goal, { waypointThreshold: 75, forceAdaptive: true })
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

/** Move within reach of a block so it can be dug or interacted with. */
export function goToBlock(bot: Bot, pos: Vec3, options: NavigateOptions) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4) return Promise.resolve()
  return navigate(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), options)
}

export function stopAllMovement(bot: Bot) {
  if (!bot.entity) return // not spawned (or already disconnected)
  bot.ashfinder.stop()
  bot.clearControlStates()
  bot.stopDigging()
}