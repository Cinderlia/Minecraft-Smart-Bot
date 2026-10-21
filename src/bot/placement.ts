import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import { ToolInputError } from '../tools/args.js'
import { errorMessage, sleep } from '../util/async.js'
import { findItem } from './inventory.js'
import { navigate } from './navigation.js'
import { goals } from './goals.js'
import { findPlaceableSpot, findPlacementReference, formatPos } from './world.js'

function isReplaceable(block: Block | null): boolean {
  return !!block && block.boundingBox === 'empty' && !block.name.includes('door') && !block.name.includes('sign')
}

function botOccupies(bot: Bot, pos: Vec3): boolean {
  const feet = bot.entity.position.floored()
  return feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)
}

/**
 * Air (or water) cells with at least one solid neighbour, within `radius` of
 * `origin`, excluding the bot's own body cells. Sorted nearest-first.
 * This is what place_block uses to pick where to put a block, so the LLM does
 * not have to guess exact coordinates.
 */
export function findPlacementCandidates(bot: Bot, origin: Vec3, radius: number): Vec3[] {
  const base = origin.floored()
  const out: Vec3[] = []
  const feet = bot.entity.position.floored()
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = base.offset(dx, dy, dz)
        const block = bot.blockAt(pos)
        if (!block) continue // chunk not loaded
        // Placeable on air or water.
        if (block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'water') continue
        // Do not suggest the cell the bot is standing in.
        if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) continue
        // Needs a solid neighbour to click against.
        const neighbours = [
          pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
          pos.offset(0, 1, 0), pos.offset(0, -1, 0),
          pos.offset(0, 0, 1), pos.offset(0, 0, -1)
        ]
        const hasSolid = neighbours.some(n => bot.blockAt(n)?.boundingBox === 'block')
        if (!hasSolid) continue
        out.push(pos)
      }
    }
  }
  out.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  return out
}

/** Place an inventory item as a block at `target`, walking into reach first. */
export async function placeBlockAt(bot: Bot, itemName: string, target: Vec3, signal: AbortSignal): Promise<Block> {
  const item = findItem(bot, itemName)
  if (!item) throw new ToolInputError(`No ${itemName} in inventory`)

  const existing = bot.blockAt(target)
  if (!existing) throw new ToolInputError(`Position ${formatPos(target)} is not loaded`)
  if (!isReplaceable(existing)) throw new ToolInputError(`${formatPos(target)} is occupied by ${existing.name}`)

  const placement = findPlacementReference(bot, target)
  if (!placement) throw new ToolInputError(`Nothing solid next to ${formatPos(target)} to place against; build up from the ground`)

  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.5) {
    await navigate(bot, new goals.GoalNear(target.x, target.y, target.z, 3), { signal })
  }
  if (botOccupies(bot, target)) {
    await navigate(bot, new goals.GoalInvert(new goals.GoalNear(target.x, target.y, target.z, 1.5)), { signal })
  }

  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(placement.reference, placement.face)
  } catch (error) {
    // placeBlock sometimes times out waiting for the server ack even though the block was placed.
    await sleep(250)
    const placed = bot.blockAt(target)
    if (!placed || isReplaceable(placed)) throw new Error(`Failed to place ${itemName}: ${errorMessage(error)}`)
  }

  const placed = bot.blockAt(target)
  if (!placed || isReplaceable(placed)) throw new Error(`Failed to place ${itemName} at ${formatPos(target)}`)
  return placed
}

/** Place a block from inventory somewhere right next to the bot. */
export async function placeBlockNearby(bot: Bot, itemName: string, signal: AbortSignal): Promise<Block> {
  const spot = findPlaceableSpot(bot)
  if (!spot) throw new ToolInputError('No free spot next to me to place a block')
  return placeBlockAt(bot, itemName, spot, signal)
}