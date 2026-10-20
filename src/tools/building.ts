import { Vec3 } from 'vec3'
import { countItem } from '../bot/inventory.js'
import { placeBlockAt, placeBlockNearby } from '../bot/placement.js'
import { formatPos, resolveItem } from '../bot/world.js'
import { TaskCancelledError, errorMessage, throwIfAborted } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readOptionalPosition } from './types.js'

const category = 'Building'
const maxFillVolume = 512
/** Radius around the bot to search for placeable spots when reporting suggestions. */
const SUGGEST_RADIUS = 4
/** Max suggestions to include in a tool result. */
const SUGGEST_LIMIT = 12

type Spot = { x: number; y: number; z: number }

/**
 * Find absolute coordinates around the bot where a new block could be placed:
 * empty cell, at least one solid neighbour (required by placeBlockAt).
 * Excludes the bot's own body cells.
 */
function findPlaceableSpots(bot: import('mineflayer').Bot, radius = SUGGEST_RADIUS, limit = SUGGEST_LIMIT): Spot[] {
  const p = bot.entity?.position
  if (!p) return []
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  const out: Spot[] = []
  for (let dy = -2; dy <= 3 && out.length < limit; dy++) {
    for (let dx = -radius; dx <= radius && out.length < limit; dx++) {
      for (let dz = -radius; dz <= radius && out.length < limit; dz++) {
        const x = bx + dx, y = by + dy, z = bz + dz
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue
        const here = bot.blockAt(new Vec3(x, y, z))
        if (!here || here.boundingBox !== 'empty') continue
        const neighbours = [
          bot.blockAt(new Vec3(x + 1, y, z)),
          bot.blockAt(new Vec3(x - 1, y, z)),
          bot.blockAt(new Vec3(x, y + 1, z)),
          bot.blockAt(new Vec3(x, y - 1, z)),
          bot.blockAt(new Vec3(x, y, z + 1)),
          bot.blockAt(new Vec3(x, y, z - 1))
        ]
        if (!neighbours.some(n => n && n.boundingBox === 'block')) continue
        out.push({ x, y, z })
      }
    }
  }
  return out
}

function formatSpots(spots: Spot[]): string {
  return spots.map(s => `(${s.x}, ${s.y}, ${s.z})`).join(', ')
}

export const buildingTools = [
  defineTool({
    name: 'place_block',
    category,
    description:
      'Place a SINGLE block from the inventory at absolute world coordinates (needs a solid neighbouring block), or right next to the bot if coordinates are omitted. ' +
      'ALWAYS compute the target coordinate from the Terrain section of Current state: Terrain lists solid blocks as absolute-coordinate boxes and their air holes. ' +
      'A coordinate is placeable only if Terrain (or a later tool result) shows it as air and it has a solid neighbour. Do NOT guess or try coordinates one by one. ' +
      'For 2+ blocks of the same type, or walls/floors/shelters, use fill_region instead. ' +
      'If a placement fails, the result lists nearby placeable spots — pick one of those coordinates instead of digging or retrying the same spot.',
    params: {
      item: { type: 'string', description: 'Block item to place, e.g. "cobblestone", "torch", "crafting_table"', required: true },
      ...positionParams('absolute world coordinates (omit for next to the bot)', false)
    },
    async handler(args, { bot, signal }) {
      const name = resolveItem(bot, args.string('item')).name
      const pos = readOptionalPosition(args)
      try {
        const placed = pos ? await placeBlockAt(bot, name, pos, signal) : await placeBlockNearby(bot, name, signal)
        const spots = findPlaceableSpots(bot)
        const hint = spots.length > 0 ? ` Nearby placeable spots: ${formatSpots(spots)}.` : ''
        return `Placed ${placed.name} at ${formatPos(placed.position)}.${hint}`
      } catch (error) {
        if (error instanceof TaskCancelledError) throw error
        const spots = findPlaceableSpots(bot)
        const hint = spots.length > 0
          ? ` Nearby placeable spots (empty cell with a solid neighbour): ${formatSpots(spots)}. Pick one of these coordinates from Terrain instead of digging.`
          : ' No nearby placeable spots found; move to open ground first.'
        throw new ToolInputError(`${errorMessage(error)}.${hint}`)
      }
    }
  }),

  defineTool({
    name: 'fill_region',
    category,
    description:
      `Fill a cuboid between two opposite corners with a block, building bottom layer first (max ${maxFillVolume} blocks). ` +
      'PRIMARY tool for huts, shelters, walls, floors, pillars and any structure of 2+ blocks. ' +
      'ALWAYS compute both corners from the Terrain section of Current state. Terrain lists solid blocks as absolute-coordinate boxes; choose corners so the box sits in air (or in holes) rather than overlapping existing solid cells. ' +
      'IMPORTANT: cells that are already solid are skipped and reported as "N already occupied" — when that happens, re-read Terrain and pick different corners; do not dig existing blocks. ' +
      'Example shelter: a 5×4×5 hollow box whose floor sits on top of the Terrain floor layer → fill_region(item, x1, floorY+1, z1, x1+4, floorY+4, z1+4, hollow: true), then place_block one wall block for the door. ' +
      `If the region exceeds ${maxFillVolume} blocks, split it into several adjacent cuboids and call this tool once per cuboid.`,
    params: {
      item: { type: 'string', description: 'Block item to place', required: true },
      x1: { type: 'number', description: 'Corner 1 X (absolute)', required: true },
      y1: { type: 'number', description: 'Corner 1 Y (absolute)', required: true },
      z1: { type: 'number', description: 'Corner 1 Z (absolute)', required: true },
      x2: { type: 'number', description: 'Corner 2 X (absolute)', required: true },
      y2: { type: 'number', description: 'Corner 2 Y (absolute)', required: true },
      z2: { type: 'number', description: 'Corner 2 Z (absolute)', required: true },
      hollow: { type: 'boolean', description: 'Only build the outer shell (walls, floor and roof) of the box' }
    },
    async handler(args, { bot, signal, log }) {
      const name = resolveItem(bot, args.string('item')).name
      const [x1, y1, z1, x2, y2, z2] = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].map(k => Math.floor(args.number(k)))
      const [minX, maxX] = [Math.min(x1, x2), Math.max(x1, x2)]
      const [minY, maxY] = [Math.min(y1, y2), Math.max(y1, y2)]
      const [minZ, maxZ] = [Math.min(z1, z2), Math.max(z1, z2)]
      const hollow = args.boolean('hollow', false)

      const targets: Vec3[] = []
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            const shell = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ
            if (!hollow || shell) targets.push(new Vec3(x, y, z))
          }
        }
      }
      if (targets.length > maxFillVolume) throw new ToolInputError(`Region has ${targets.length} blocks; max is ${maxFillVolume}. Split it up.`)

      const needed = targets.filter(p => bot.blockAt(p)?.boundingBox === 'empty').length
      const have = countItem(bot, name)
      if (have === 0) throw new ToolInputError(`No ${name} in inventory (need about ${needed})`)

      let placed = 0
      let skipped = 0
      let occupied = 0
      targets.sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      for (const pos of targets) {
        throwIfAborted(signal)
        const block = bot.blockAt(pos)
        if (block?.boundingBox !== 'empty') {
          occupied++
          continue
        }
        if (countItem(bot, name) === 0) break
        try {
          await placeBlockAt(bot, name, pos, signal)
          placed++
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          log.debug(`fill_region skip ${pos}: ${errorMessage(error)}`)
          skipped++
        }
      }

      const remaining = targets.filter(p => bot.blockAt(p)?.boundingBox === 'empty').length
      const shortage = remaining > 0 && countItem(bot, name) === 0 ? ` Ran out of ${name}.` : ''
      let extra = ''
      if (occupied > 0) {
        extra += ` ${occupied} target(s) were already occupied.`
        const spots = findPlaceableSpots(bot)
        if (spots.length > 0) {
          extra += ` Nearby placeable spots: ${formatSpots(spots)}. Re-read Terrain and pick corners that avoid these occupied cells; do not dig.`
        } else {
          extra += ' No nearby placeable spots; move to open ground first.'
        }
      }
      return `Placed ${placed} ${name}; ${remaining} still empty, ${skipped} failed, ${occupied} already occupied.${shortage}${extra}`
    }
  })
]