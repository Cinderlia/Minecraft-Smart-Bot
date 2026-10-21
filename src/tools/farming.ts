import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import { countItem, describeInventoryChange, findItem, snapshotInventory } from '../bot/inventory.js'
import { goToBlock } from '../bot/navigation.js'
import { formatPos } from '../bot/world.js'
import { TaskCancelledError, errorMessage, sleep, throwIfAborted } from '../util/async.js'
import { pickUpDrops } from './gathering.js'
import { ToolInputError } from './args.js'
import { defineTool } from './types.js'

const category = 'Farming'

type CropKind = 'replant' | 'block' | 'cane' | 'berry'
type CropInfo = { kind: CropKind; seed?: string; soil?: string[] }

/** Crops the bot knows how to harvest, how to tell they are ripe, and what to replant. */
const crops: Record<string, CropInfo> = {
  wheat: { kind: 'replant', seed: 'wheat_seeds', soil: ['farmland'] },
  carrots: { kind: 'replant', seed: 'carrot', soil: ['farmland'] },
  potatoes: { kind: 'replant', seed: 'potato', soil: ['farmland'] },
  beetroots: { kind: 'replant', seed: 'beetroot_seeds', soil: ['farmland'] },
  nether_wart: { kind: 'replant', seed: 'nether_wart', soil: ['soul_sand'] },
  melon: { kind: 'block' },
  pumpkin: { kind: 'block' },
  sugar_cane: { kind: 'cane' },
  sweet_berry_bush: { kind: 'berry' }
}

/** Valid seed item ids the bot can plant. */
const VALID_SEEDS = [...new Set(Object.values(crops).map(c => c.seed).filter((s): s is string => !!s))]

function maxAge(bot: Bot, name: string): number | null {
  const age = bot.registry.blocksByName[name]?.states?.find((s: { name: string }) => s.name === 'age')
  return age ? (age.num_values ?? 1) - 1 : null
}

function ageOf(block: Block): number {
  return Number((block.getProperties() as { age?: number | string }).age ?? 0)
}

/** Ripe and worth harvesting right now. Sugar cane is ripe above the bottom block, so the base keeps growing. */
function isRipe(bot: Bot, block: Block | null, wanted: Set<string>): boolean {
  if (!block || !wanted.has(block.name)) return false
  const info = crops[block.name]
  if (info.kind === 'block') return true
  if (info.kind === 'cane') {
    if (!block.position) return true
    return bot.blockAt(block.position.offset(0, -1, 0))?.name === 'sugar_cane'
  }
  const max = maxAge(bot, block.name)
  if (max === null) return true
  return info.kind === 'berry' ? ageOf(block) >= 2 : ageOf(block) >= max
}

function resolveCrops(raw: string | undefined): Set<string> {
  if (!raw || ['all', 'crops', 'crop', 'farm', 'any'].includes(raw.toLowerCase())) return new Set(Object.keys(crops))
  const name = raw.trim().toLowerCase().replace(/\s+/g, '_')
  const aliases: Record<string, string> = {
    carrot: 'carrots', potato: 'potatoes', beetroot: 'beetroots', wart: 'nether_wart', melons: 'melon',
    pumpkins: 'pumpkin', cane: 'sugar_cane', sugarcane: 'sugar_cane', berries: 'sweet_berry_bush', sweet_berries: 'sweet_berry_bush'
  }
  const crop = crops[name] ? name : aliases[name]
  if (!crop) throw new ToolInputError(`Unknown crop "${raw}". Known: ${Object.keys(crops).join(', ')}, or "all"`)
  return new Set([crop])
}

/** Plant `seed` on top of `soil` if the spot above it is empty. */
async function plantOn(bot: Bot, soil: Block, seed: string): Promise<boolean> {
  const item = findItem(bot, seed)
  const above = bot.blockAt(soil.position.offset(0, 1, 0))
  if (!item || !above || above.name !== 'air') return false
  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(soil, new Vec3(0, 1, 0))
  } catch {
    await sleep(200)
  }
  return bot.blockAt(soil.position.offset(0, 1, 0))?.name !== 'air'
}

export const farmingTools = [
  defineTool({
    name: 'harvest_crops',
    category,
    description:
      'Harvest every RIPE crop in an area and replant it (unripe crops are left alone). Handles wheat, carrots, potatoes, beetroots, ' +
      'nether wart, melons, pumpkins, sugar cane (leaves the bottom block) and sweet berries. Keeps going until nothing ripe is left ' +
      'or the time limit is reached, then picks up the drops. Use this for any "harvest/farm the crops" request.',
    params: {
      crop: { type: 'string', description: 'Crop to harvest, or "all" (default all)' },
      radius: { type: 'number', description: 'Search radius in blocks (default 32)' },
      replant: { type: 'boolean', description: 'Replant seeds after harvesting (default true)' },
      max_minutes: { type: 'number', description: 'Time limit in minutes (default 5, max 20)' }
    },
    async handler(args, { bot, signal, log }) {
      const wanted = resolveCrops(args.optionalString('crop'))
      const radius = args.optionalNumber('radius', { min: 4, max: 64 }) ?? 32
      const replant = args.boolean('replant', true)
      const deadline = Date.now() + (args.optionalNumber('max_minutes', { min: 0.5, max: 20 }) ?? 5) * 60_000
      const center = bot.entity.position.clone()
      const before = snapshotInventory(bot)
      const skipped = new Set<string>()
      const harvested = new Map<string, number>()
      let replanted = 0
      const missingSeeds = new Set<string>()
      let failures = 0
      let stoppedBy = 'nothing ripe left'

      while (true) {
        throwIfAborted(signal)
        if (Date.now() > deadline) { stoppedBy = 'time limit reached'; break }
        if (failures >= 8) { stoppedBy = 'too many unreachable crops'; break }

        const target = bot.findBlocks({ matching: (b: Block) => isRipe(bot, b, wanted), maxDistance: radius, count: 64, point: center })
          .filter(pos => !skipped.has(pos.toString()) && isRipe(bot, bot.blockAt(pos), wanted))
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
        if (!target) break

        const block = bot.blockAt(target)!
        const info = crops[block.name]
        try {
          await goToBlock(bot, target, { signal })
          if (info.kind === 'berry') {
            await bot.activateBlock(block)
          } else {
            const onAbort = () => bot.stopDigging()
            signal.addEventListener('abort', onAbort, { once: true })
            try { await bot.dig(block, true) } finally { signal.removeEventListener('abort', onAbort) }
          }
          harvested.set(block.name, (harvested.get(block.name) ?? 0) + 1)
          failures = 0

          if (replant && info.kind === 'replant' && info.seed) {
            await sleep(150, signal)
            const soil = bot.blockAt(target.offset(0, -1, 0))
            if (soil && info.soil?.includes(soil.name)) {
              if (await plantOn(bot, soil, info.seed)) replanted++
              else if (countItem(bot, info.seed) === 0) missingSeeds.add(info.seed)
            }
          }
          const total = [...harvested.values()].reduce((a, b) => a + b, 0)
          if (total % 6 === 0) await pickUpDrops(bot, target, 5, signal)
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          log.debug(`harvest skip ${formatPos(target)}: ${errorMessage(error)}`)
          skipped.add(target.toString())
          failures++
        }
      }

      await pickUpDrops(bot, bot.entity.position, Math.min(radius, 16), signal)

      const stillGrowing = bot.findBlocks({
        matching: (b: Block) => !!b && wanted.has(b.name) && crops[b.name].kind !== 'block' && crops[b.name].kind !== 'cane' && !isRipe(bot, b, wanted),
        maxDistance: radius, count: 512, point: center
      }).length
      const total = [...harvested.values()].reduce((a, b) => a + b, 0)
      const breakdown = [...harvested.entries()].map(([name, n]) => `${n} ${name}`).join(', ')
      const seeds = missingSeeds.size > 0 ? ` Ran out of ${[...missingSeeds].join(', ')} for replanting.` : ''
      if (total === 0) {
        return `Nothing ripe to harvest within ${radius} blocks (${stillGrowing} crop(s) still growing). Crops need time to grow; check back later or bone meal them.`
      }
      return `Harvested ${total} (${breakdown}), replanted ${replanted}; stopped: ${stoppedBy}. ${stillGrowing} crop(s) still growing.${seeds} ` +
        `Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  }),

  defineTool({
    name: 'plant_seeds',
    category,
    description:
      'Plant seeds on every empty farmland/soul sand nearby. Valid seed items: ' + VALID_SEEDS.join(', ') + '. ' +
      'Note: carrots use the item "carrot" (not "carrot_seeds"); potatoes use "potato". ' +
      'Requires farmland next to water — till dirt with a hoe first (use_item_on_block).',
    params: {
      seed: { type: 'string', description: `Seed item to plant (one of: ${VALID_SEEDS.join(', ')}; omit for any available seeds)` },
      radius: { type: 'number', description: 'Search radius in blocks (default 16)' }
    },
    async handler(args, { bot, signal, log }) {
      const seedCrops = Object.values(crops).filter(c => c.kind === 'replant')
      const requested = args.optionalString('seed')?.toLowerCase().replace(/\s+/g, '_')
      const options = seedCrops.filter(c => (requested ? c.seed === requested : countItem(bot, c.seed!) > 0))
      if (options.length === 0) {
        const hint = requested
          ? `"${requested}" is not a plantable seed. Valid: ${VALID_SEEDS.join(', ')}. (Carrots use "carrot", not "carrot_seeds".)`
          : `No seeds in inventory. Valid: ${VALID_SEEDS.join(', ')}.`
        throw new ToolInputError(hint)
      }
      const radius = args.optionalNumber('radius', { min: 2, max: 48 }) ?? 16
      const soils = new Set(options.flatMap(c => c.soil!))
      const skipped = new Set<string>()
      let planted = 0

      for (let i = 0; i < 256; i++) {
        throwIfAborted(signal)
        const crop = options.find(c => countItem(bot, c.seed!) > 0)
        if (!crop) break
        const spot = bot.findBlocks({ matching: (b: Block) => !!b && soils.has(b.name), maxDistance: radius, count: 256 })
          .filter(pos => !skipped.has(pos.toString()) && crop.soil!.includes(bot.blockAt(pos)?.name ?? '') && bot.blockAt(pos.offset(0, 1, 0))?.name === 'air')
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
        if (!spot) break
        try {
          await goToBlock(bot, spot, { signal })
          if (await plantOn(bot, bot.blockAt(spot)!, crop.seed!)) planted++
          else skipped.add(spot.toString())
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          log.debug(`plant skip ${formatPos(spot)}: ${errorMessage(error)}`)
          skipped.add(spot.toString())
        }
      }
      return planted > 0
        ? `Planted ${planted} seed(s).`
        : 'No empty farmland to plant on (till dirt next to water with a hoe first: use_item_on_block).'
    }
  })
]