import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { goals } from 'mineflayer-pathfinder'
import { MissingMaterialError, allRecipesFor, describeMissing, ensureItem, ingredientsOf, listRecipes, planMaterials, rankRecipes } from '../bot/crafting.js'
import { countItem, countItemId, describeInventoryChange, snapshotInventory } from '../bot/inventory.js'
import { navigate } from '../bot/navigation.js'
import { placeBlockNearby } from '../bot/placement.js'
import { resolveItem } from '../bot/world.js'
import { fuelValue, smeltingInputsFor, smeltingRecipes } from '../knowledge/smelting.js'
import { TaskCancelledError, errorMessage, sleep, throwIfAborted } from '../util/async.js'
import { ToolInputError } from './args.js'
import { defineTool } from './types.js'

const category = 'Crafting & smelting'

async function ensureFurnace(bot: Bot, signal: AbortSignal, steps: string[]): Promise<Block> {
  let furnace = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 })
  if (!furnace) {
    await ensureItem(bot, bot.registry.itemsByName.furnace.id, 1, signal, steps)
    furnace = await placeBlockNearby(bot, 'furnace', signal)
    steps.push('placed a furnace')
  }
  const { x, y, z } = furnace.position
  await navigate(bot, new goals.GoalNear(x, y, z, 3), { signal })
  return furnace
}

function tableNearby(bot: Bot): boolean {
  return !!bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 })
}

const tierOrder = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const gems = new Set(['coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone'])

/** "mining cobblestone needs wooden_pickaxe or better" when the bot lacks a suitable tool. */
function toolHint(bot: Bot, itemName: string): string | null {
  const blockName = itemName.startsWith('raw_') ? `${itemName.slice(4)}_ore`
    : gems.has(itemName) ? `${itemName.replace('_lazuli', '')}_ore`
    : itemName === 'cobblestone' ? 'stone' : itemName
  const block = bot.registry.blocksByName[blockName]
  if (!block?.harvestTools) return null
  const ids = Object.keys(block.harvestTools).map(Number)
  if (bot.inventory.items().some(i => ids.includes(i.type))) return null
  const weakest = ids.map(id => bot.registry.items[id].name)
    .sort((a, b) => tierOrder.indexOf(a.split('_')[0]) - tierOrder.indexOf(b.split('_')[0]))[0]
  return `mining ${blockName} for ${itemName} needs a ${weakest} or better (craft it first)`
}

/** The collect_block argument that yields `itemName`, or null if it isn't mined from a block. */
function gatherQuery(bot: Bot, itemName: string): string | null {
  if (itemName.endsWith('_log')) return 'log'
  if (itemName === 'cobblestone') return 'stone'
  if (itemName.startsWith('raw_')) return itemName.slice(4)
  if (gems.has(itemName)) return itemName.replace('_lazuli', '')
  if (smeltingInputsFor(itemName).length > 0) return null
  return bot.registry.blocksByName[itemName] ? itemName : null
}

/** Total raw materials still needed, with how to get each one. */
function materialsAdvice(bot: Bot, itemId: number, count: number): string {
  const plan = planMaterials(bot, itemId, count, tableNearby(bot))
  if (plan.missing.size === 0) return 'All materials are available.'
  const hints = [...plan.missing.keys()]
    .map(name => [name, smeltingInputsFor(name)] as const)
    .filter(([, inputs]) => inputs.length > 0)
    .map(([name, inputs]) => `${name} comes from smelting ${inputs.slice(0, 2).join(' or ')}`)
  hints.push(...[...plan.missing.keys()].map(name => toolHint(bot, name)).filter((h): h is string => !!h))
  const table = plan.needsTable ? ' (includes wood for a crafting table)' : ''
  const calls = [...plan.missing.entries()]
    .map(([name, n]) => {
      const query = gatherQuery(bot, name)
      return query ? `collect_block ${query} count ${n}` : null
    })
    .filter((c): c is string => !!c)
  const suggestion = calls.length > 0 ? ` Suggested: ${[...new Set(calls)].join(', then ')}.` : ''
  return `Still need to gather in total: ${describeMissing(plan.missing)}${table}. ${hints.length > 0 ? hints.join('; ') + '. ' : ''}` +
    `Gather the full amounts in one call each, then call craft_item again.${suggestion}`
}

function pickFuel(bot: Bot, exclude: string): string | undefined {
  return bot.inventory.items()
    .filter(i => i.name !== exclude && fuelValue(i.name) > 0)
    .sort((a, b) => fuelValue(b.name) - fuelValue(a.name))[0]?.name
}

export const craftingTools = [
  defineTool({
    name: 'craft_item',
    category,
    description:
      'Craft an item in ONE call: automatically crafts all intermediate parts (planks, sticks, ...) from raw materials ' +
      'and finds, places or crafts a crafting table. Do not craft the parts yourself. If raw materials are missing it lists the total to gather. ' +
      'If you are unsure which recipe variant to use (wood types, alternatives), call list_recipes first to see all options.',
    params: {
      item: { type: 'string', description: 'Item to craft, e.g. "stone_pickaxe", "torch", "oak_planks"', required: true },
      count: { type: 'integer', description: 'Number of items to craft (default 1)' }
    },
    async handler(args, { bot, signal }) {
      const item = resolveItem(bot, args.string('item'))
      const count = args.int('count', 1, { min: 1, max: 256 })
      if (allRecipesFor(bot, item.id).length === 0) {
        const smelt = smeltingInputsFor(item.name)
        const hint = smelt.length > 0 ? ` It is made by smelting ${smelt.slice(0, 3).join(' / ')} (use smelt_item).` : ' It must be gathered, mined, or looted.'
        throw new ToolInputError(`${item.name} has no crafting recipe.${hint}`)
      }

      // Plan first so a doomed craft fails cleanly instead of half-crafting intermediates.
      const plan = planMaterials(bot, item.id, count, tableNearby(bot))
      if (plan.missing.size > 0) throw new ToolInputError(`Cannot craft ${count} ${item.name} yet. ${materialsAdvice(bot, item.id, count)}`)

      const before = snapshotInventory(bot)
      const steps: string[] = []
      try {
        await ensureItem(bot, item.id, countItemId(bot, item.id) + count, signal, steps)
      } catch (error) {
        if (error instanceof TaskCancelledError) throw error
        const done = steps.length > 0 ? ` Progress so far: ${steps.join('; ')}.` : ''
        if (error instanceof MissingMaterialError) {
          throw new ToolInputError(`Cannot craft ${count} ${item.name} yet. ${materialsAdvice(bot, item.id, count)}${done}`)
        }
        throw new Error(`Crafting ${item.name} failed: ${errorMessage(error)}.${done}`)
      }
      return `Done: ${steps.join('; ')}. Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`
    }
  }),

  defineTool({
    name: 'get_recipe',
    category,
    description: 'Plan how to make an item: ingredients (with how many you have), crafting table need, smelting input, and the TOTAL raw materials still to gather. Use before multi-step crafting. ' +
      'For a flat list of every possible recipe variant (including ones you cannot craft yet), use list_recipes.',
    params: {
      item: { type: 'string', description: 'Item name', required: true },
      count: { type: 'integer', description: 'How many you want (default 1); used to total up raw materials' }
    },
    async handler(args, { bot }) {
      const item = resolveItem(bot, args.string('item'))
      const lines: string[] = []

      const recipes = rankRecipes(bot, allRecipesFor(bot, item.id), () => 1).slice(0, 3)
      for (const recipe of recipes) {
        const parts = ingredientsOf(bot, recipe).map(ing => `${ing.count} ${ing.name} (have ${countItemId(bot, ing.id)})`)
        lines.push(`Craft -> ${recipe.result.count} ${item.name}: ${parts.join(' + ')}${recipe.requiresTable ? ' [needs crafting table]' : ' [2x2, no table needed]'}`)
      }
      if (recipes.length === 3) lines.push('(other wood/material variants also work)')

      const inputs = smeltingInputsFor(item.name)
      if (inputs.length > 0) lines.push(`Smelt in a furnace: ${inputs.join(' / ')} -> ${item.name}`)
      if (smeltingRecipes[item.name]) lines.push(`Smelting ${item.name} produces ${smeltingRecipes[item.name]}`)

      if (recipes.length > 0) lines.push(materialsAdvice(bot, item.id, args.int('count', 1, { min: 1, max: 256 })))
      return lines.length > 0 ? lines.join('\n') : `${item.name} cannot be crafted or smelted; gather, mine, or loot it.`
    }
  }),

  defineTool({
    name: 'list_recipes',
    category,
    description:
      'List every crafting recipe for an item, including recipes the bot cannot craft yet (different wood types, alternative ingredients). ' +
      'Use this to inspect alternatives before deciding what to gather or which variant to craft. ' +
      'For "what do I still need to gather", use get_recipe instead. ' +
      'For "just make it", use craft_item.',
    params: {
      item: { type: 'string', description: 'Item name or id (e.g. "diamond_pickaxe", "chest")', required: true },
      limit: { type: 'integer', description: 'Max recipes to list (default 5, max 20)' }
    },
    async handler(args, { bot }) {
      const raw = args.string('item').trim()
      const item = bot.registry.itemsByName[raw] ?? bot.registry.items[Number(raw)]
      if (!item) throw new ToolInputError(`Unknown item "${raw}"`)
      const recipes = listRecipes(bot, item.id)
      if (recipes.length === 0) {
        const smelt = smeltingInputsFor(item.name)
        const hint = smelt.length > 0 ? ` It is made by smelting ${smelt.slice(0, 3).join(' / ')} (use smelt_item).` : ' It must be gathered, mined, or looted.'
        return `No crafting recipe for ${item.name}.${hint}`
      }
      const limit = args.int('limit', 5, { min: 1, max: 20 })
      const lines = recipes.slice(0, limit).map((r, i) => {
        const ings = r.ingredients.map(ing => `${ing.count}x ${ing.name}`).join(' + ')
        return `${i}: ${ings} -> ${r.result.count}x ${r.result.name}${r.requiresTable ? ' (needs crafting table)' : ''}`
      })
      const more = recipes.length > limit ? `\n... and ${recipes.length - limit} more` : ''
      return `${recipes.length} recipe(s) for ${item.name}:\n${lines.join('\n')}${more}`
    }
  }),

  defineTool({
    name: 'smelt_item',
    category,
    description:
      'Smelt or cook items in a furnace (finds or places one; crafts one from 8 cobblestone if needed). ' +
      'Picks fuel automatically (coal, charcoal, wood). Waits for the results and takes them.',
    params: {
      item: { type: 'string', description: 'Item to put in, e.g. "raw_iron", "sand", "beef". The desired output ("iron_ingot") also works.', required: true },
      count: { type: 'integer', description: 'How many to smelt (default: all of that input, max 64)' },
      fuel: { type: 'string', description: 'Fuel item to use (default: automatic)' }
    },
    async handler(args, { bot, signal }) {
      let input = resolveItem(bot, args.string('item')).name
      if (!smeltingRecipes[input]) {
        const alt = smeltingInputsFor(input).find(i => countItem(bot, i) > 0)
        if (!alt) throw new ToolInputError(`Don't know how to smelt ${input}, and no item in the inventory smelts into it`)
        input = alt
      }
      const available = countItem(bot, input)
      if (available === 0) throw new ToolInputError(`No ${input} in inventory`)
      const count = Math.min(args.int('count', available, { min: 1, max: 64 }), available)

      const fuelName = args.optionalString('fuel') ? resolveItem(bot, args.string('fuel')).name : pickFuel(bot, input)
      if (!fuelName || countItem(bot, fuelName) === 0) throw new ToolInputError('No fuel in inventory (coal, charcoal, logs or planks)')
      if (fuelValue(fuelName) === 0) throw new ToolInputError(`${fuelName} is not a furnace fuel`)

      const before = snapshotInventory(bot)
      const steps: string[] = []
      const block = await ensureFurnace(bot, signal, steps)
      const furnace = await bot.openFurnace(block)
      let taken = 0
      try {
        if (furnace.outputItem()) await furnace.takeOutput()

        const fuelNeeded = Math.ceil(count / fuelValue(fuelName))
        const fuelToAdd = Math.max(0, Math.min(fuelNeeded - (furnace.fuelItem()?.count ?? 0), countItem(bot, fuelName)))
        if (fuelToAdd > 0) await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelToAdd)
        await furnace.putInput(bot.registry.itemsByName[input].id, null, count)

        // Each item takes 10 seconds to smelt.
        const deadline = Date.now() + count * 10_500 + 15_000
        while (taken < count && Date.now() < deadline) {
          throwIfAborted(signal)
          await sleep(1000, signal)
          const out = furnace.outputItem()
          if (out) {
            taken += out.count
            await furnace.takeOutput()
          }
          if (!furnace.inputItem() && !furnace.outputItem()) break
          if (!furnace.fuelItem() && furnace.fuel === 0 && furnace.inputItem()) {
            steps.push('furnace ran out of fuel')
            break
          }
        }
      } finally {
        furnace.close()
      }

      const output = smeltingRecipes[input]
      const change = describeInventoryChange(before, snapshotInventory(bot))
      const prefix = steps.length > 0 ? `${steps.join('; ')}. ` : ''
      if (taken < count) return `${prefix}Smelted ${taken}/${count} ${input} -> ${output} (stopped early; leftovers may still be in the furnace). Inventory change: ${change}`
      return `${prefix}Smelted ${taken} ${input} -> ${output}. Inventory change: ${change}`
    }
  })
]