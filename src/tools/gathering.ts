import { Bot } from 'mineflayer'
import { goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { canHarvest, describeInventoryChange, equipBestToolFor, requiredHarvestTools, snapshotInventory } from '../bot/inventory.js'
import { goToBlock, navigate } from '../bot/navigation.js'
import { formatPos, resolveBlockFamily } from '../bot/world.js'
import { TaskCancelledError, errorMessage, sleep, throwIfAborted, withTimeout } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readPosition } from './types.js'

const category = 'Gathering'

/** Radius around the bot to search for diggable blocks when reporting suggestions. */
const DIG_SUGGEST_RADIUS = 4
const DIG_SUGGEST_LIMIT = 12

/** Blocks that are never worth suggesting as dig targets. */
const NOT_DIGGABLE = new Set([
  'air', 'cave_air', 'void_air',
  'water', 'flowing_water', 'bubble_column',
  'lava', 'flowing_lava',
  'bedrock'
])

type DigSpot = { x: number; y: number; z: number; name: string }

/**
 * Find absolute coordinates of blocks around the bot that can be dug.
 * Used to steer the model toward real coordinates on a failed dig.
 */
function findDiggableSpots(bot: Bot, radius = DIG_SUGGEST_RADIUS, limit = DIG_SUGGEST_LIMIT): DigSpot[] {
  const p = bot.entity?.position
  if (!p) return []
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  const out: DigSpot[] = []
  for (let dy = -2; dy <= 3 && out.length < limit; dy++) {
    for (let dx = -radius; dx <= radius && out.length < limit; dx++) {
      for (let dz = -radius; dz <= radius && out.length < limit; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue
        const x = bx + dx, y = by + dy, z = bz + dz
        const block = bot.blockAt(new Vec3(x, y, z))
        if (!block) continue
        if (NOT_DIGGABLE.has(block.name)) continue
        out.push({ x, y, z, name: block.name })
      }
    }
  }
  return out
}

function formatDigSpots(spots: DigSpot[]): string {
  return spots.map(s => `(${s.x}, ${s.y}, ${s.z}) ${s.name}`).join(', ')
}

function digSpotHint(bot: Bot, prefix: string): string {
  const spots = findDiggableSpots(bot)
  if (spots.length === 0) return `${prefix} No diggable blocks nearby; move to another area.`
  return `${prefix} Nearby diggable blocks: ${formatDigSpots(spots)}. Pick one of these coordinates from Terrain instead of guessing.`
}

/** Walk over dropped items near `around` so they get picked up. */
export async function pickUpDrops(bot: Bot, around: Vec3, radius: number, signal: AbortSignal): Promise<number> {
  await sleep(250, signal)
  let visited = 0
  for (let attempt = 0; attempt < 8; attempt++) {
    const drop = Object.values(bot.entities)
      .filter(e => e.name === 'item' && e.position.distanceTo(around) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!drop) break
    const { x, y, z } = drop.position
    try {
      await withTimeout(navigate(bot, new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)), { signal }), 8000, 'Pickup')
      await sleep(200, signal)
      visited++
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error
      break
    }
  }
  return visited
}

async function digAt(bot: Bot, pos: Vec3, signal: AbortSignal) {
  const block = bot.blockAt(pos)
  if (!block || block.name === 'air' || block.name === 'cave_air') throw new ToolInputError(`No block at ${formatPos(pos)}`)
  if (!block.diggable) throw new ToolInputError(`${block.name} cannot be broken`)
  if (!canHarvest(bot, block)) {
    throw new ToolInputError(`${block.name} needs one of: ${requiredHarvestTools(bot, block)!.join(', ')} (it would drop nothing otherwise)`)
  }

  await goToBlock(bot, pos, { signal, allowDig: true })
  throwIfAborted(signal)
  await equipBestToolFor(bot, block)

  const onAbort = () => bot.stopDigging()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await bot.dig(block, true)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  throwIfAborted(signal)
  return block.name
}

export const gatheringTools = [
  defineTool({
    name: 'collect_block',
    category,
    description:
      'Find, walk to, mine and pick up blocks of a type — use when the player wants to KEEP the block (gather wood, stone, dirt to build with). ' +
      'Picks the best tool automatically. ' +
      'Accepts families: "log"/"wood" (any tree), "stone" (drops cobblestone), "iron"/"coal"/"diamond" (ores incl. deepslate), "sand", "dirt". ' +
      'Do NOT use this to CLEAR/REMOVE blocks from an existing structure — for that, read the Terrain section to find their coordinates and call dig_block.',
    params: {
      block: { type: 'string', description: 'Block name or family to mine', required: true },
      count: { type: 'integer', description: 'How many blocks to mine (default 1, max 64)' },
      max_distance: { type: 'number', description: 'Search radius (default 64)' }
    },
    async handler(args, { bot, signal, log }) {
      const { ids, names } = resolveBlockFamily(bot, args.string('block'))
      const count = args.int('count', 1, { min: 1, max: 64 })
      const maxDistance = args.optionalNumber('max_distance', { min: 4, max: 128 }) ?? 64
      const before = snapshotInventory(bot)
      const skipped = new Set<string>()
      let mined = 0
      let failures = 0
      let lastError = ''

      while (mined < count && failures < 5) {
        throwIfAborted(signal)
        const candidates = bot.findBlocks({ matching: ids, maxDistance, count: 32 })
          .filter(pos => !skipped.has(pos.toString()))
        if (candidates.length === 0) break

        const pos = candidates[0]
        const block = bot.blockAt(pos)!
        if (!canHarvest(bot, block)) {
          throw new ToolInputError(`${block.name} needs one of: ${requiredHarvestTools(bot, block)!.join(', ')}. Craft or obtain one first.`)
        }

        try {
          await digAt(bot, pos, signal)
          await pickUpDrops(bot, pos, 6, signal)
          mined++
          failures = 0
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          lastError = errorMessage(error)
          log.debug(`Skipping block at ${pos}: ${lastError}`)
          skipped.add(pos.toString())
          failures++
        }
      }

      const change = describeInventoryChange(before, snapshotInventory(bot))
      if (mined === 0) {
        const reason = lastError ? ` Last error: ${lastError}` : ' Try explore to find more.'
        return `Mined nothing: no reachable ${names.slice(0, 4).join('/')} within ${maxDistance} blocks.${reason}`
      }
      const shortfall = mined < count ? ` (wanted ${count}; ran out of reachable blocks)` : ''
      return `Mined ${mined} block(s)${shortfall}. Inventory change: ${change}`
    }
  }),

  defineTool({
    name: 'dig_block',
    category,
    description:
      'Break the SINGLE block at absolute coordinates and pick up its drop. Use this when the player wants a block GONE (clear / remove / clean / dig out / break / destroy / empty / open up). ' +
      'ALWAYS compute the target coordinate from the Terrain section of Current state: Terrain lists solid blocks as absolute-coordinate boxes and their air holes. Pick a coordinate that Terrain shows as that block type; do not guess or sweep coordinates one by one. ' +
      'Use this for a specific block (a door opening, clearing dirt inside a room), not for gathering many — use collect_block for that. ' +
      'On failure ("No block at X" or "cannot be broken") the result lists nearby diggable blocks; pick one of those coordinates from Terrain instead of guessing. ' +
      'Do NOT dig to make room for building — re-read Terrain and pick an empty spot.',
    params: positionParams('absolute coordinates of the block to break'),
    async handler(args, { bot, signal }) {
      const pos = readPosition(args)
      const before = snapshotInventory(bot)
      try {
        const name = await digAt(bot, pos, signal)
        await pickUpDrops(bot, pos, 5, signal)
        const change = describeInventoryChange(before, snapshotInventory(bot))
        const hint = digSpotHint(bot, '')
        return `Broke ${name} at ${formatPos(pos)}. Inventory change: ${change}.${hint}`
      } catch (error) {
        if (error instanceof TaskCancelledError) throw error
        const hint = digSpotHint(bot, '')
        throw new ToolInputError(`${errorMessage(error)}.${hint}`)
      }
    }
  }),

  defineTool({
    name: 'pick_up_items',
    category,
    description: 'Collect dropped items lying on the ground nearby.',
    params: {
      radius: { type: 'number', description: 'Search radius (default 16)' }
    },
    async handler(args, { bot, signal }) {
      const before = snapshotInventory(bot)
      const radius = args.optionalNumber('radius', { min: 1, max: 32 }) ?? 16
      await pickUpDrops(bot, bot.entity.position, radius, signal)
      return `Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  })
]