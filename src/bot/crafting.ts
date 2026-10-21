import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Recipe } from 'prismarine-recipe'
import { goals } from './goals.js'
import { TaskCancelledError, throwIfAborted } from '../util/async.js'
import { countItemId, snapshotInventory } from './inventory.js'
import { navigate } from './navigation.js'
import { placeBlockNearby } from './placement.js'

/** An ingredient that has no crafting recipe from what the bot has: it must be gathered, smelted or looted. */
export class MissingMaterialError extends Error {
  constructor(
    public readonly item: string,
    public readonly count: number,
    /** True when the item is only craftable from its own ancestor (iron_block <- iron_ingot): a storage form, not a real source. */
    public readonly cyclic = false
  ) {
    super(`missing ${count}x ${item}`)
    this.name = 'MissingMaterialError'
  }
}

export type Ingredient = { id: number; name: string; count: number }

export function ingredientsOf(bot: Bot, recipe: Recipe, times = 1): Ingredient[] {
  return recipe.delta
    .filter(d => d.count < 0)
    .map(d => ({ id: d.id, name: bot.registry.items[d.id]?.name ?? `#${d.id}`, count: -d.count * times }))
}

/** How many ingredient units are missing to perform `recipe` `times` times. */
function shortfall(bot: Bot, recipe: Recipe, times: number): number {
  return ingredientsOf(bot, recipe, times)
    .reduce((sum, ing) => sum + Math.max(0, ing.count - countItemId(bot, ing.id)), 0)
}

/** Prefer recipe variants (e.g. oak vs. birch planks) that match materials already held. */
function affinity(bot: Bot, recipe: Recipe): number {
  const held = [...snapshotInventory(bot).keys()]
  return ingredientsOf(bot, recipe).filter(ing => {
    const prefix = ing.name.split('_')[0]
    return held.some(name => name === ing.name || (prefix.length > 2 && name.startsWith(prefix + '_')))
  }).length
}

/** Recipes that just recolour/convert an existing variant (orange_bed + dye -> white_bed), when that variant isn't held. */
function isUnheldConversion(bot: Bot, recipe: Recipe, held: (id: number) => number): boolean {
  const kind = (name: string) => name.split('_').pop()
  const result = bot.registry.items[recipe.result.id]?.name ?? ''
  return ingredientsOf(bot, recipe).some(ing => ing.id !== recipe.result.id && kind(ing.name) === kind(result) && held(ing.id) === 0)
}

const commonIngredients = new Set(['cobblestone', 'coal', 'stick', 'white_wool', 'iron_ingot', 'string'])

/** Last-resort tie-break: the everyday variant (oak, cobblestone, coal) over exotic ones. */
function commonness(bot: Bot, recipe: Recipe): number {
  return ingredientsOf(bot, recipe).filter(ing => commonIngredients.has(ing.name) || ing.name.startsWith('oak_')).length
}

export function rankRecipes(bot: Bot, recipes: Recipe[], times: (r: Recipe) => number): Recipe[] {
  const held = (id: number) => countItemId(bot, id)
  const conversion = (r: Recipe) => (isUnheldConversion(bot, r, held) ? 1 : 0)
  return [...recipes].sort((a, b) =>
    conversion(a) - conversion(b) ||
    shortfall(bot, a, times(a)) - shortfall(bot, b, times(b)) ||
    affinity(bot, b) - affinity(bot, a) ||
    commonness(bot, b) - commonness(bot, a))
}

export function allRecipesFor(bot: Bot, itemId: number): Recipe[] {
  return bot.recipesAll(itemId, null, true)
}

/** Find a nearby crafting table, or place/craft one, and walk to it. */
export async function ensureCraftingTable(bot: Bot, signal: AbortSignal, steps: string[]): Promise<Block> {
  const tableId = bot.registry.blocksByName.crafting_table.id
  let table = bot.findBlock({ matching: tableId, maxDistance: 32 })

  if (!table) {
    const itemId = bot.registry.itemsByName.crafting_table.id
    if (countItemId(bot, itemId) === 0) {
      await ensureItem(bot, itemId, 1, signal, steps)
    }
    table = await placeBlockNearby(bot, 'crafting_table', signal)
    steps.push('placed a crafting table')
  }

  const { x, y, z } = table.position
  await navigate(bot, new goals.GoalNear(x, y, z, 3), { signal })
  return table
}

/**
 * Make sure the inventory holds at least `needed` of an item, crafting it and
 * any intermediate ingredients (planks, sticks, ...) as required.
 */
export async function ensureItem(
  bot: Bot,
  itemId: number,
  needed: number,
  signal: AbortSignal,
  steps: string[],
  ancestors: Set<number> = new Set()
): Promise<void> {
  throwIfAborted(signal)
  const name = bot.registry.items[itemId].name
  const have = countItemId(bot, itemId)
  if (have >= needed) return
  const missing = needed - have

  const allRecipes = allRecipesFor(bot, itemId)
  const recipes = allRecipes
    .filter(r => !ingredientsOf(bot, r).some(ing => ancestors.has(ing.id) || ing.id === itemId))
  if (recipes.length === 0 || ancestors.size >= 5) {
    throw new MissingMaterialError(name, missing, allRecipes.length > 0 && recipes.length === 0)
  }

  const timesFor = (r: Recipe) => Math.ceil(missing / r.result.count)
  let firstError: unknown

  for (const recipe of rankRecipes(bot, recipes, timesFor).slice(0, 12)) {
    const times = timesFor(recipe)
    const ingredients = ingredientsOf(bot, recipe, times)
    const path = new Set([...ancestors, itemId])
    try {
      // Crafting one ingredient can consume another (sticks eat planks), so re-check a few rounds.
      for (let round = 0; round < 3; round++) {
        for (const ing of ingredients) await ensureItem(bot, ing.id, ing.count, signal, steps, path)
        if (ingredients.every(ing => countItemId(bot, ing.id) >= ing.count)) break
      }
      const table = recipe.requiresTable ? await ensureCraftingTable(bot, signal, steps) : undefined
      await bot.craft(recipe, times, table)
      steps.push(`crafted ${times * recipe.result.count} ${name}`)
      return
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error
      // A storage form (block/nugget) of this item is not a useful thing to ask for; report this item instead.
      firstError ??= error instanceof MissingMaterialError && error.cyclic ? new MissingMaterialError(name, missing) : error
    }
  }

  throw firstError
}

/** Craftable in theory, but in practice you gather them (wool from sheep, not 4 string + dye). */
function gatherPreferred(name: string): boolean {
  return name.endsWith('_wool')
}

export type MaterialPlan = {
  /** Raw materials (not craftable from what is held) still to gather/smelt, by item name. */
  missing: Map<string, number>
  /** Whether a crafting table will have to be crafted as part of the plan. */
  needsTable: boolean
}

/**
 * Dry-run the crafting tree for `count` more of an item against the current
 * inventory, without crafting anything. Returns the total raw materials that
 * are still missing, so the LLM can gather everything in one go.
 */
export function planMaterials(bot: Bot, itemId: number, count: number, tableNearby: boolean): MaterialPlan {
  const virtual = new Map<number, number>()
  for (const item of bot.inventory.items()) virtual.set(item.type, (virtual.get(item.type) ?? 0) + item.count)
  const missing = new Map<string, number>()
  let tableAvailable = tableNearby || (virtual.get(bot.registry.itemsByName.crafting_table.id) ?? 0) > 0
  let needsTable = false

  const virtualShortfall = (recipe: Recipe, times: number) => ingredientsOf(bot, recipe, times)
    .reduce((sum, ing) => sum + Math.max(0, ing.count - (virtual.get(ing.id) ?? 0)), 0)

  function produce(id: number, amount: number, ancestors: Set<number>) {
    const name = bot.registry.items[id].name
    const path = new Set([...ancestors, id])
    // Skip recipes that go through a storage form (coal <- coal_block <- coal): they never help.
    const isStorageForm = (ingId: number) => {
      const sub = allRecipesFor(bot, ingId)
      return sub.length > 0 && sub.every(r => ingredientsOf(bot, r).some(ing => path.has(ing.id)))
    }
    const held = (ingId: number) => virtual.get(ingId) ?? 0
    const recipes = allRecipesFor(bot, id)
      .filter(r => !ingredientsOf(bot, r).some(ing => path.has(ing.id) || isStorageForm(ing.id)))
      .filter(r => !isUnheldConversion(bot, r, held))
    if (recipes.length === 0 || ancestors.size >= 5 || gatherPreferred(name)) {
      missing.set(name, (missing.get(name) ?? 0) + amount)
      return
    }
    const timesFor = (r: Recipe) => Math.ceil(amount / r.result.count)
    const recipe = [...recipes].sort((a, b) =>
      virtualShortfall(a, timesFor(a)) - virtualShortfall(b, timesFor(b)) ||
      affinity(bot, b) - affinity(bot, a) ||
      commonness(bot, b) - commonness(bot, a))[0]
    const times = timesFor(recipe)
    for (const ing of ingredientsOf(bot, recipe, times)) consume(ing.id, ing.count, path)
    if (recipe.requiresTable && !tableAvailable) {
      tableAvailable = true
      needsTable = true
      produce(bot.registry.itemsByName.crafting_table.id, 1, new Set())
    }
    virtual.set(id, (virtual.get(id) ?? 0) + times * recipe.result.count - amount)
  }

  function consume(id: number, amount: number, ancestors: Set<number>) {
    const have = virtual.get(id) ?? 0
    const used = Math.min(have, amount)
    virtual.set(id, have - used)
    if (amount > used) produce(id, amount - used, ancestors)
  }

  produce(itemId, count, new Set())
  return { missing, needsTable }
}

/** "2 log (any wood type), 3 cobblestone" — wood variants are collapsed since any type works. */
export function describeMissing(missing: Map<string, number>): string {
  const merged = new Map<string, number>()
  for (const [name, count] of missing) {
    const key = name.endsWith('_log') ? 'log (any wood type)' : name.endsWith('_planks') ? 'planks (any wood type)' : name
    merged.set(key, (merged.get(key) ?? 0) + count)
  }
  return [...merged.entries()].map(([name, count]) => `${count} ${name}`).join(', ')
}

export type RecipeSummary = {
  ingredients: { name: string; count: number }[]
  result: { name: string; count: number }
  requiresTable: boolean
}

/** List every crafting recipe for an item, including ones the bot cannot craft yet. */
export function listRecipes(bot: Bot, itemId: number): RecipeSummary[] {
  return allRecipesFor(bot, itemId).map(r => ({
    ingredients: ingredientsOf(bot, r).map(ing => ({ name: ing.name, count: ing.count })),
    result: {
      name: bot.registry.items[r.result.id]?.name ?? `#${r.result.id}`,
      count: r.result.count
    },
    requiresTable: r.requiresTable
  }))
}