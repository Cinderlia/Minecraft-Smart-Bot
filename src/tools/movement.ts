import { Vec3 } from 'vec3'
import { goals } from '../bot/goals.js'
import { goToPosition, navigate, stopAllMovement } from '../bot/navigation.js'
import { findEntity, findNearestBlock, formatPos, resolveBlockFamily } from '../bot/world.js'
import { sleep } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readPosition } from './types.js'

const category = 'Movement'

/**
 * Background follow loops, keyed by bot. Baritone has no persistent follow
 * goal, so we keep re-issuing a short goto until stop() clears it.
 */
const followLoops = new WeakMap<object, { stopped: boolean }>()

export const movementTools = [
  defineTool({
    name: 'go_to',
    category,
    description: 'Pathfind to coordinates. Walks, jumps and swims around obstacles automatically; never breaks blocks.',
    params: {
      ...positionParams('the destination'),
      range: { type: 'number', description: 'How close to get, in blocks (default 1)' }
    },
    async handler(args, { bot, signal }) {
      const target = readPosition(args)
      const range = args.optionalNumber('range', { min: 0, max: 32 }) ?? 1
      await goToPosition(bot, target, range, { signal })
      return `Arrived near ${formatPos(target)} (now at ${formatPos(bot.entity.position)})`
    }
  }),

  defineTool({
    name: 'go_to_player',
    category,
    description: 'Walk to a player. Use the requester\'s name for "come here".',
    params: {
      username: { type: 'string', description: 'Player username', required: true },
      distance: { type: 'number', description: 'How close to stop, in blocks (default 2)' }
    },
    async handler(args, { bot, signal }) {
      const username = args.string('username')
      const entity = bot.players[username]?.entity ?? findEntity(bot, username, 256)
      if (!entity || entity.type !== 'player') {
        throw new ToolInputError(`Player ${username} is not within render distance`)
      }
      const distance = args.optionalNumber('distance', { min: 1, max: 16 }) ?? 2
      const { x, y, z } = entity.position
      await navigate(bot, new goals.GoalNear(x, y, z, distance), { signal })
      return `Reached ${username} at ${formatPos(bot.entity.position)}`
    }
  }),

  defineTool({
    name: 'follow',
    category,
    description:
      'Keep following a player or entity in the background until told to stop. Returns immediately. ' +
      'Stop it with the stop tool or by starting another task.',
    params: {
      target: { type: 'string', description: 'Player username or mob name', required: true },
      distance: { type: 'number', description: 'Distance to keep, in blocks (default 3)' }
    },
    async handler(args, { bot }) {
      const target = args.string('target')
      const entity = findEntity(bot, target, 128)
      if (!entity) throw new ToolInputError(`Cannot see "${target}"`)

      // Cancel any previous follow loop.
      const previous = followLoops.get(bot)
      if (previous) previous.stopped = true

      const distance = args.optionalNumber('distance', { min: 1, max: 16 }) ?? 3
      const state = { stopped: false }
      followLoops.set(bot, state)

      // Background loop: re-issue a short chase goal every 500ms.
      void (async () => {
        while (!state.stopped) {
          const live = findEntity(bot, target, 128)
          if (!live) break
          try {
            await bot.ashfinder.gotoSmart(
              new goals.GoalNear(live.position.x, live.position.y, live.position.z, distance),
              { waypointThreshold: 10, forceAdaptive: true }
            )
          } catch {
            // unreachable this round; retry on the next tick
          }
          await sleep(500)
        }
      })()

      return `Now following ${target}. Call stop to end.`
    }
  }),

  defineTool({
    name: 'go_to_block',
    category,
    description: 'Walk to the nearest block of a type, e.g. "crafting_table", "water", "oak_log".',
    params: {
      block: { type: 'string', description: 'Block name or family (e.g. "log", "bed")', required: true },
      max_distance: { type: 'number', description: 'Search radius (default 64)' }
    },
    async handler(args, { bot, signal }) {
      const { ids, names } = resolveBlockFamily(bot, args.string('block'))
      const block = findNearestBlock(bot, ids, args.optionalNumber('max_distance', { min: 1, max: 128 }) ?? 64)
      if (!block) throw new ToolInputError(`No ${names.slice(0, 3).join('/')} found nearby. Try explore.`)
      await navigate(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 }), { signal })
      return `Standing next to ${block.name} at ${formatPos(block.position)}`
    }
  }),

  defineTool({
    name: 'explore',
    category,
    description: 'Travel a distance in a compass direction to discover new terrain and resources.',
    params: {
      direction: {
        type: 'string',
        description: 'Compass direction (default: random)',
        enum: ['north', 'south', 'east', 'west', 'random']
      },
      distance: { type: 'number', description: 'Blocks to travel (default 48, max 200)' }
    },
    async handler(args, { bot, signal }) {
      const dirs: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
      let direction = args.enumValue('direction', ['north', 'south', 'east', 'west', 'random'], 'random')
      if (direction === 'random') direction = (['north', 'south', 'east', 'west'] as const)[Math.floor(Math.random() * 4)]
      const distance = args.optionalNumber('distance', { min: 8, max: 200 }) ?? 48
      const [dx, dz] = dirs[direction]
      const start = bot.entity.position
      await navigate(bot, new goals.GoalNearXZ(start.x + dx * distance, start.z + dz * distance, 4), { signal })
      return `Explored ${direction}; now at ${formatPos(bot.entity.position)}`
    }
  }),

  defineTool({
    name: 'move',
    category,
    description: 'Hold a raw movement key for a short time. Prefer go_to for real navigation.',
    params: {
      direction: { type: 'string', description: 'Direction to move', enum: ['forward', 'back', 'left', 'right'], required: true },
      seconds: { type: 'number', description: 'Duration, 0.1–5 seconds', required: true },
      sprint: { type: 'boolean', description: 'Sprint while moving' }
    },
    async handler(args, { bot, signal }) {
      const direction = args.enumValue('direction', ['forward', 'back', 'left', 'right'])
      const seconds = args.number('seconds', { min: 0.1, max: 5 })
      bot.setControlState('sprint', args.boolean('sprint', false))
      bot.setControlState(direction, true)
      try {
        await sleep(seconds * 1000, signal)
      } finally {
        bot.setControlState(direction, false)
        bot.setControlState('sprint', false)
      }
      return `Moved ${direction} for ${seconds}s; now at ${formatPos(bot.entity.position)}`
    }
  }),

  defineTool({
    name: 'jump',
    category,
    description: 'Jump once.',
    params: {},
    async handler(_args, { bot, signal }) {
      bot.setControlState('jump', true)
      try {
        await sleep(400, signal)
      } finally {
        bot.setControlState('jump', false)
      }
      return 'Jumped'
    }
  }),

  defineTool({
    name: 'look_at',
    category,
    description: 'Turn to face a player, entity, or coordinates.',
    params: {
      target: { type: 'string', description: 'Player or mob name (omit to use coordinates)' },
      ...positionParams('the point to look at', false)
    },
    async handler(args, { bot }) {
      const target = args.optionalString('target')
      if (target) {
        const entity = findEntity(bot, target)
        if (!entity) throw new ToolInputError(`Cannot see "${target}"`)
        await bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0))
        return `Looking at ${target}`
      }
      const pos = readPosition(args)
      await bot.lookAt(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
      return `Looking at ${formatPos(pos)}`
    }
  }),

  defineTool({
    name: 'stop',
    category,
    description: 'Stop all movement, following, digging and attacking.',
    params: {},
    async handler(_args, { bot }) {
      const state = followLoops.get(bot)
      if (state) state.stopped = true
      followLoops.delete(bot)
      stopAllMovement(bot)
      return 'Stopped'
    }
  })
]