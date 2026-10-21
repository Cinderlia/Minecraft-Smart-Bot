import { Bot } from 'mineflayer'
import { Entity } from 'prismarine-entity'
import { goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { describeInventoryChange, findItem, snapshotInventory } from '../bot/inventory.js'
import { goToBlock, navigate } from '../bot/navigation.js'
import { entityLabel, findEntity, formatPos, nearbyEntities, resolveItem } from '../bot/world.js'
import { sleep, throwIfAborted, withTimeout } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool, positionParams, readOptionalPosition, readPosition } from './types.js'

const category = 'Interaction'

/** Set by mineflayer at runtime but missing from its typings. */
function vehicleOf(bot: Bot): Entity | null {
  return (bot as Bot & { vehicle?: Entity | null }).vehicle ?? null
}

/** Reject coordinates that are implausibly far from the bot — usually a dropped minus sign. */
function assertNearBot(bot: Bot, pos: Vec3, tool: string): void {
  const b = bot.entity.position
  const dy = Math.abs(Math.floor(pos.y) - Math.floor(b.y))
  if (dy > 64) {
    throw new ToolInputError(
      `${tool}: target y=${Math.floor(pos.y)} is ${dy} blocks from the bot (y=${Math.floor(b.y)}). ` +
      'Check the coordinate for a missing minus sign — copy coordinates from the Terrain section exactly.'
    )
  }
}

export const interactionTools = [
  defineTool({
    name: 'activate_block',
    category,
    description: 'Right-click a block: open/close doors, trapdoors and gates, flip levers, press buttons, ring bells.',
    params: positionParams('the block'),
    async handler(args, { bot, signal }) {
      const pos = readPosition(args)
      assertNearBot(bot, pos, 'activate_block')
      const block = bot.blockAt(pos)
      if (!block || block.name === 'air') throw new ToolInputError(`No block at ${formatPos(pos)}`)
      await goToBlock(bot, pos, { signal })
      await bot.activateBlock(block)
      return `Activated ${block.name} at ${formatPos(pos)}`
    }
  }),

  defineTool({
    name: 'use_item_on_block',
    category,
    description:
      'Use an item on a block: till dirt with a hoe, bone meal crops, light with flint_and_steel, pour a water/lava bucket, plant seeds on farmland. ' +
      'The target must be an absolute coordinate from the Terrain section of Current state; copy it exactly (mind the minus sign on y).',
    params: {
      item: { type: 'string', description: 'Item to use (equipped automatically)', required: true },
      ...positionParams('the target block (absolute coords)')
    },
    async handler(args, { bot, signal }) {
      const name = resolveItem(bot, args.string('item')).name
      const item = findItem(bot, name)
      if (!item) throw new ToolInputError(`No ${name} in inventory`)
      const pos = readPosition(args)
      assertNearBot(bot, pos, 'use_item_on_block')
      const block = bot.blockAt(pos)
      if (!block) throw new ToolInputError(`Block at ${formatPos(pos)} is not loaded`)

      // Hoeing farmland again does nothing; report that instead of pretending it worked.
      if (name.endsWith('_hoe') && block.name === 'farmland') {
        return `Already farmland at ${formatPos(pos)}; nothing to do.`
      }

      const before = block.name
      await goToBlock(bot, pos, { signal })
      await bot.equip(item, 'hand')
      await bot.lookAt(pos.offset(0.5, 1, 0.5), true)
      await bot.activateBlock(block, new Vec3(0, 1, 0))
      await sleep(400, signal)
      const after = bot.blockAt(pos)?.name ?? 'unknown'
      if (after === before && name.endsWith('_hoe') && before !== 'farmland') {
        // The update may simply be late; give it one more moment.
        await sleep(400, signal)
      }
      const final = bot.blockAt(pos)?.name ?? 'unknown'
      if (name.endsWith('_hoe') && before === 'dirt' && final !== 'farmland') {
        return `Hoe used on dirt at ${formatPos(pos)} but the block did not become farmland (it is ${final}). Farmland needs an adjacent water block within 4 blocks; add water first.`
      }
      return `Used ${name} on ${before} at ${formatPos(pos)}; it is now ${final}`
    }
  }),

  defineTool({
    name: 'use_held_item',
    category,
    description:
      'Right-click with an item in the air: drink potions, throw snowballs/eggs/ender pearls, fill an empty bucket while looking at water, ' +
      'draw and release a bow (set hold_seconds ~1).',
    params: {
      item: { type: 'string', description: 'Item to use (default: currently held)' },
      hold_seconds: { type: 'number', description: 'How long to hold right-click (bows, shields, drinking; default 0)' },
      ...positionParams('a point to look at first (optional)', false)
    },
    async handler(args, { bot, signal }) {
      const requested = args.optionalString('item')
      if (requested) {
        const name = resolveItem(bot, requested).name
        const item = findItem(bot, name)
        if (!item) throw new ToolInputError(`No ${name} in inventory`)
        await bot.equip(item, 'hand')
      }
      const target = readOptionalPosition(args)
      if (target) await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
      const before = snapshotInventory(bot)
      const hold = args.optionalNumber('hold_seconds', { min: 0, max: 5 }) ?? 0
      bot.activateItem()
      if (hold > 0) {
        await sleep(hold * 1000, signal)
        bot.deactivateItem()
      }
      await sleep(300, signal)
      return `Used ${bot.heldItem?.name ?? 'item'}. Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  }),

  defineTool({
    name: 'interact_entity',
    category,
    description:
      'Right-click a mob, optionally holding an item: breed animals (wheat for cows/sheep, seeds for chickens, carrots for pigs), ' +
      'shear sheep, milk cows with a bucket, tame wolves with bones, put a saddle on a pig/horse.',
    params: {
      target: { type: 'string', description: 'Mob name or player', required: true },
      item: { type: 'string', description: 'Item to hold while interacting (optional)' }
    },
    async handler(args, { bot, signal }) {
      const target = args.string('target')
      const entity = findEntity(bot, target, 32)
      if (!entity) throw new ToolInputError(`Cannot see "${target}" nearby`)
      const requested = args.optionalString('item')
      if (requested) {
        const name = resolveItem(bot, requested).name
        const item = findItem(bot, name)
        if (!item) throw new ToolInputError(`No ${name} in inventory`)
        await bot.equip(item, 'hand')
      }
      const before = snapshotInventory(bot)
      const { x, y, z } = entity.position
      await navigate(bot, new goals.GoalNear(x, y, z, 2), { signal })
      await bot.lookAt(entity.position.offset(0, entity.height * 0.6, 0), true)
      await bot.activateEntity(entity)
      await sleep(300, signal)
      return `Interacted with ${entityLabel(entity)}. Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  }),

  defineTool({
    name: 'mount',
    category,
    description: 'Ride the nearest boat, minecart, horse, pig, etc.',
    params: {
      target: { type: 'string', description: 'Vehicle or mob name (default: nearest rideable)' }
    },
    async handler(args, { bot, signal }) {
      const rideable = /boat|minecart|horse|donkey|mule|pig|strider|camel|llama|raft/
      const target = args.optionalString('target')
      const entity = target
        ? findEntity(bot, target, 16)
        : nearbyEntities(bot, 16).find(e => rideable.test(e.name ?? ''))
      if (!entity) throw new ToolInputError('Nothing rideable nearby')
      const { x, y, z } = entity.position
      await navigate(bot, new goals.GoalNear(x, y, z, 2), { signal })
      bot.mount(entity)
      await sleep(500, signal)
      return vehicleOf(bot) ? `Riding ${entityLabel(entity)}` : `Tried to mount ${entityLabel(entity)} but it did not work (may need a saddle)`
    }
  }),

  defineTool({
    name: 'dismount',
    category,
    description: 'Get off the current vehicle or mount.',
    params: {},
    async handler(_args, { bot }) {
      if (!vehicleOf(bot)) return 'Not riding anything'
      bot.dismount()
      return 'Dismounted'
    }
  }),

  defineTool({
    name: 'fish',
    category,
    description: 'Fish with a fishing rod. Stand next to water first (go_to_block water).',
    params: {
      catches: { type: 'integer', description: 'How many catches to try for (default 3, max 10)' }
    },
    async handler(args, { bot, signal }) {
      const rod = findItem(bot, 'fishing_rod')
      if (!rod) throw new ToolInputError('No fishing_rod in inventory (craft from 3 sticks + 2 string)')
      const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 6 })
      if (!water) throw new ToolInputError('No water within 6 blocks; go to water first')
      await bot.equip(rod, 'hand')
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true)

      const before = snapshotInventory(bot)
      const catches = args.int('catches', 3, { min: 1, max: 10 })
      let caught = 0
      for (let i = 0; i < catches; i++) {
        throwIfAborted(signal)
        const onAbort = () => bot.activateItem()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await withTimeout(bot.fish(), 60_000, 'Fishing')
          caught++
        } catch {
          break
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
      throwIfAborted(signal)
      return `Caught ${caught} time(s). Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  }),

  defineTool({
    name: 'trade_with_villager',
    category,
    description: 'List the nearest villager\'s trades, or perform one by its index.',
    params: {
      trade_index: { type: 'integer', description: 'Trade to perform (omit to just list trades)' },
      times: { type: 'integer', description: 'How many times to repeat the trade (default 1)' }
    },
    async handler(args, { bot, signal }) {
      const villager = findEntity(bot, 'villager', 32)
      if (!villager) throw new ToolInputError('No villager within 32 blocks')
      const { x, y, z } = villager.position
      await navigate(bot, new goals.GoalNear(x, y, z, 2), { signal })
      const window = await bot.openVillager(villager)
      try {
        const index = args.optionalNumber('trade_index')
        if (index === undefined) {
          return window.trades.map((t, i) => {
            const cost = [t.inputItem1, t.inputItem2].filter(Boolean).map(it => `${it!.count} ${it!.name}`).join(' + ')
            return `${i}: ${cost} -> ${t.outputItem.count} ${t.outputItem.name}${t.tradeDisabled ? ' (out of stock)' : ''}`
          }).join('\n') || 'This villager has no trades'
        }
        const before = snapshotInventory(bot)
        await bot.trade(window, Math.floor(index), args.int('times', 1, { min: 1, max: 64 }))
        return `Traded. Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
      } finally {
        window.close()
      }
    }
  })
]