import { Vec3 } from 'vec3'
import { countItem } from '../bot/inventory.js'
import { findPlacementCandidates, placeBlockAt } from '../bot/placement.js'
import { formatPos, resolveItem } from '../bot/world.js'
import { TaskCancelledError, errorMessage, throwIfAborted } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readOptionalPosition } from './types.js'

const category = 'Building'
const maxFillVolume = 512
/** Radius to search for placeable cells around a requested origin. */
const PLACE_RADIUS = 4
const PLACE_RADIUS_EXTENDED = 6
/** Max candidates to actually try before giving up at a given radius. */
const MAX_CANDIDATES = 3

export const buildingTools = [
  defineTool({
    name: 'place_block',
    category,
    description:
      'Place a SINGLE block from the inventory near a target position. ' +
      'Pass absolute world coordinates to place near that spot, or omit them to place next to the bot. ' +
      'The bot picks a valid empty cell (air or water) that has a solid neighbour within 4 blocks of the target, extending to 6 if needed, so you do not need to guess exact coordinates. ' +
      'If you read Terrain, use it to choose the target area, not a specific cell. ' +
      'For 2+ blocks of the same type, or walls/floors/shelters, use fill_region instead.',
    params: {
      item: { type: 'string', description: 'Block item to place, e.g. "cobblestone", "torch", "crafting_table"', required: true },
      ...positionParams('target area centre (absolute). Omit to place next to the bot.', false)
    },
    async handler(args, { bot, signal }) {
      const name = resolveItem(bot, args.string('item')).name
      if (countItem(bot, name) === 0) throw new ToolInputError(`No ${name} in inventory`)

      const requested = readOptionalPosition(args)
      const origin = requested ?? bot.entity.position.floored()

      // Try radius 4, then 6. The algorithm picks candidate cells, not the LLM.
      for (const radius of [PLACE_RADIUS, PLACE_RADIUS_EXTENDED]) {
        const candidates = findPlacementCandidates(bot, origin, radius)
        if (candidates.length === 0) continue

        const errors: string[] = []
        const tried = candidates.slice(0, MAX_CANDIDATES)
        for (const pos of tried) {
          throwIfAborted(signal)
          try {
            const placed = await placeBlockAt(bot, name, pos, signal)
            const hint = requested
              ? ` (requested near ${formatPos(requested)}, placed at ${formatPos(placed.position)})`
              : ''
            return `Placed ${placed.name} at ${formatPos(placed.position)}${hint}.`
          } catch (error) {
            if (error instanceof TaskCancelledError) throw error
            errors.push(`${formatPos(pos)}: ${errorMessage(error)}`)
          }
        }

        const triedList = tried.map(p => formatPos(p)).join(', ')
        throw new ToolInputError(
          `Could not place ${name} within ${radius} of ${formatPos(origin)}. Tried ${triedList}; errors: ${errors.join(' | ')}. ` +
          'Move to an open area or pick a different target area.'
        )
      }

      throw new ToolInputError(
        `No empty cell with a solid neighbour within ${PLACE_RADIUS_EXTENDED} blocks of ${formatPos(origin)} for ${name}. ` +
        'Move to open ground first, or revise the task.'
      )
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
        const spots = findPlacementCandidates(bot, bot.entity.position.floored(), 4)
        if (spots.length > 0) {
          const listed = spots.slice(0, 12).map(p => `(${p.x}, ${p.y}, ${p.z})`).join(', ')
          extra += ` Nearby placeable spots: ${listed}. Re-read Terrain and pick corners that avoid these occupied cells; do not dig.`
        } else {
          extra += ' No nearby placeable spots; move to open ground first.'
        }
      }
      return `Placed ${placed} ${name}; ${remaining} still empty, ${skipped} failed, ${occupied} already occupied.${shortage}${extra}`
    }
  })
]