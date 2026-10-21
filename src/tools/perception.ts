import { Vec3 } from 'vec3'
import { requiredHarvestTools, summarizeInventory, freeSlots, canHarvest } from '../bot/inventory.js'
import { describeStatus } from '../bot/status.js'
import { entityLabel, formatPos, isHostile, nearbyEntities, resolveBlockFamily } from '../bot/world.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readPosition } from './types.js'

const category = 'Perception'

export const perceptionTools = [
  defineTool({
    name: 'get_status',
    category,
    description: 'Health, hunger, position, dimension, biome, time of day, weather and equipped gear.',
    params: {},
    async handler(_args, { bot }) {
      return describeStatus(bot)
    }
  }),

  defineTool({
    name: 'check_inventory',
    category,
    description: 'List everything in the inventory with counts.',
    params: {},
    async handler(_args, { bot }) {
      return `Inventory (${freeSlots(bot)} free slots): ${summarizeInventory(bot)}`
    }
  }),

  defineTool({
    name: 'look_around',
    category,
    description: 'List nearby players, mobs, animals and dropped items with positions and distances.',
    params: {
      radius: { type: 'number', description: 'Search radius in blocks (default 24)' }
    },
    async handler(args, { bot }) {
      const radius = args.optionalNumber('radius', { min: 1, max: 96 }) ?? 24
      const entities = nearbyEntities(bot, radius).slice(0, 25)
      if (entities.length === 0) return `Nothing within ${radius} blocks`
      return entities.map(e => {
        const tag = isHostile(e) ? ' [hostile]' : ''
        return `${entityLabel(e)}${tag} at ${formatPos(e.position)}, ${e.position.distanceTo(bot.entity.position).toFixed(1)}m`
      }).join('\n')
    }
  }),

  defineTool({
    name: 'find_blocks',
    category,
    description: 'Locate the nearest blocks of a type. Accepts exact names ("iron_ore") or families ("log", "iron", "bed", "water"). ' +
      'For a full list of every cell of one exact block type in a small radius, use find_block_cells instead.',
    params: {
      block: { type: 'string', description: 'Block name or family', required: true },
      max_distance: { type: 'number', description: 'Search radius (default 64, max 128)' },
      count: { type: 'integer', description: 'Max results (default 5)' }
    },
    async handler(args, { bot }) {
      const { ids, names } = resolveBlockFamily(bot, args.string('block'))
      const positions = bot.findBlocks({
        matching: ids,
        maxDistance: args.optionalNumber('max_distance', { min: 1, max: 128 }) ?? 64,
        count: args.int('count', 5, { min: 1, max: 20 })
      })
      if (positions.length === 0) return `No ${names.slice(0, 4).join('/')} found nearby`
      return positions.map(pos => {
        const block = bot.blockAt(pos)
        return `${block?.name ?? '?'} at ${formatPos(pos)}, ${pos.distanceTo(bot.entity.position).toFixed(0)}m`
      }).join('\n')
    }
  }),

  defineTool({
    name: 'find_block_cells',
    category,
    description:
      'List the exact absolute coordinates of EVERY block of one type within a radius around the bot, nearest first. ' +
      'Use this to verify what was built, count a patch, or plan clearing a room — one call replaces inspecting cells one by one. ' +
      'Requires an exact block id (e.g. "dirt", "cherry_planks"); do NOT pass families. ' +
      'For "go mine some X" use find_blocks or collect_block instead.',
    params: {
      block: { type: 'string', description: 'Exact block id (e.g. "cherry_planks", "dirt")', required: true },
      radius: { type: 'number', description: 'Search radius in blocks (default 6, max 16)' },
      limit: { type: 'integer', description: 'Max cells to list (default 64, max 256)' }
    },
    async handler(args, { bot }) {
      const name = args.string('block').trim()
      const radius = args.optionalNumber('radius', { min: 1, max: 16 }) ?? 6
      const limit = args.int('limit', 64, { min: 1, max: 256 })

      const blockId = bot.registry.blocksByName[name]?.id
      if (blockId === undefined) {
        const sample = Object.keys(bot.registry.blocksByName).slice(0, 12).join(', ')
        throw new ToolInputError(`Unknown block "${name}". Pass an exact block id (e.g. dirt, cherry_planks). Some known ids: ${sample}, ...`)
      }

      const positions = bot.findBlocks({ matching: blockId, maxDistance: radius, count: limit })
      if (positions.length === 0) return `No "${name}" within ${radius} blocks.`

      const p = bot.entity.position
      const listed = positions
        .map(pos => ({ pos, d: pos.distanceTo(p) }))
        .sort((a, b) => a.d - b.d)
        .map(({ pos, d }) => `(${pos.x}, ${pos.y}, ${pos.z}) ${d.toFixed(1)}m`)

      const more = positions.length >= limit ? ` (capped at ${limit}; raise limit or shrink radius for more)` : ''
      return `${name} within ${radius} blocks — ${listed.length} cell(s), nearest first${more}:\n${listed.join(', ')}`
    }
  }),

  defineTool({
    name: 'inspect_block',
    category,
    description: 'Describe the block at coordinates: name, hardness, which tools can harvest it, and whether the bot can. ' +
      'For checking many coordinates at once, use find_block_cells instead of calling this repeatedly.',
    params: positionParams('the block'),
    async handler(args, { bot }) {
      const pos = readPosition(args)
      const block = bot.blockAt(pos)
      if (!block) throw new ToolInputError(`Block at ${formatPos(pos)} is not loaded`)
      const tools = requiredHarvestTools(bot, block)
      return [
        `${block.name} at ${formatPos(pos)}`,
        `hardness: ${block.hardness ?? 'n/a'}${block.diggable ? '' : ' (not diggable)'}`,
        `harvest tools: ${tools ? tools.join(', ') : 'any / hand'}`,
        `can harvest now: ${canHarvest(bot, block) ? 'yes' : 'no'}`
      ].join('\n')
    }
  }),

  defineTool({
    name: 'block_below',
    category,
    description: 'Name the blocks directly under and around the bot\'s feet (useful to know what you are standing on).',
    params: {},
    async handler(_args, { bot }) {
      const base = bot.entity.position.floored()
      const describe = (dx: number, dy: number, dz: number) => bot.blockAt(base.plus(new Vec3(dx, dy, dz)))?.name ?? '?'
      return `below: ${describe(0, -1, 0)}, feet: ${describe(0, 0, 0)}, head: ${describe(0, 1, 0)}, above: ${describe(0, 2, 0)}`
    }
  }),

  defineTool({
    name: 'list_players',
    category,
    description: 'List online players and, if visible, their positions.',
    params: {},
    async handler(_args, { bot }) {
      return Object.values(bot.players)
        .filter(p => p.username !== bot.username)
        .map(p => p.entity ? `${p.username} at ${formatPos(p.entity.position)}` : `${p.username} (not in view)`)
        .join('\n') || 'No other players online'
    }
  })
]