import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Item } from 'prismarine-item'

export function countItem(bot: Bot, itemName: string): number {
  return bot.inventory.items()
    .filter(item => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0)
}

export function countItemId(bot: Bot, id: number): number {
  return bot.inventory.items()
    .filter(item => item.type === id)
    .reduce((sum, item) => sum + item.count, 0)
}

export function findItem(bot: Bot, itemName: string): Item | undefined {
  return bot.inventory.items().find(item => item.name === itemName)
}

export type InventorySnapshot = Map<string, number>

export function snapshotInventory(bot: Bot): InventorySnapshot {
  const snapshot: InventorySnapshot = new Map()
  for (const item of bot.inventory.items()) {
    snapshot.set(item.name, (snapshot.get(item.name) ?? 0) + item.count)
  }
  return snapshot
}

/** Human-readable change between two snapshots, e.g. "+3 oak_log, -1 wooden_axe". */
export function describeInventoryChange(before: InventorySnapshot, after: InventorySnapshot): string {
  const names = new Set([...before.keys(), ...after.keys()])
  const changes: string[] = []
  for (const name of names) {
    const delta = (after.get(name) ?? 0) - (before.get(name) ?? 0)
    if (delta !== 0) changes.push(`${delta > 0 ? '+' : ''}${delta} ${name}`)
  }
  return changes.length > 0 ? changes.join(', ') : 'no change'
}

export function summarizeInventory(bot: Bot): string {
  const snapshot = snapshotInventory(bot)
  if (snapshot.size === 0) return 'empty'
  return [...snapshot.entries()].map(([name, count]) => `${name} x${count}`).join(', ')
}

export function freeSlots(bot: Bot): number {
  return bot.inventory.emptySlotCount()
}

/** Tool names that can harvest `block` with drops, or null if any tool (or a bare hand) works. */
export function requiredHarvestTools(bot: Bot, block: Block): string[] | null {
  if (!block.harvestTools) return null
  return Object.keys(block.harvestTools).map(id => bot.registry.items[Number(id)]?.name).filter(Boolean)
}

export function canHarvest(bot: Bot, block: Block): boolean {
  if (!block.harvestTools) return true
  return bot.inventory.items().some(item => block.harvestTools![item.type])
}

const toolTier = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

/**
 * Equip the best tool for a block. Baritone does not expose bestHarvestTool,
 * so pick from the inventory by harvest capability and material tier.
 */
export async function equipBestToolFor(bot: Bot, block: Block): Promise<void> {
  const harvest = block.harvestTools
  if (!harvest) return // any tool/hand works
  const candidates = bot.inventory.items().filter(i => harvest[i.type])
  if (candidates.length === 0) return
  candidates.sort((a, b) => {
    const ta = toolTier.findIndex(t => a.name.startsWith(t))
    const tb = toolTier.findIndex(t => b.name.startsWith(t))
    return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb)
  })
  const best = candidates[0]
  if (bot.heldItem?.type !== best.type) await bot.equip(best, 'hand')
}

const weaponPriority = [
  'netherite_sword', 'diamond_sword', 'netherite_axe', 'iron_sword', 'diamond_axe', 'iron_axe',
  'stone_sword', 'golden_sword', 'stone_axe', 'wooden_sword', 'golden_axe', 'wooden_axe', 'trident', 'mace'
]

export function bestWeapon(bot: Bot): Item | undefined {
  const items = bot.inventory.items()
  for (const name of weaponPriority) {
    const item = items.find(i => i.name === name)
    if (item) return item
  }
  return undefined
}

const armorSlots: Array<{ suffix: string; destination: 'head' | 'torso' | 'legs' | 'feet'; slot: number }> = [
  { suffix: '_helmet', destination: 'head', slot: 5 },
  { suffix: '_chestplate', destination: 'torso', slot: 6 },
  { suffix: '_leggings', destination: 'legs', slot: 7 },
  { suffix: '_boots', destination: 'feet', slot: 8 }
]

const armorTier = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']

function tierOf(name: string): number {
  return armorTier.findIndex(t => name.startsWith(t))
}

/** Equip the best armour piece available for each slot. Returns what was equipped. */
export async function equipBestArmor(bot: Bot): Promise<string[]> {
  const equipped: string[] = []
  for (const { suffix, destination, slot } of armorSlots) {
    const current = bot.inventory.slots[slot]
    const candidates = bot.inventory.items()
      .filter(i => i.name.endsWith(suffix) || (suffix === '_helmet' && i.name === 'turtle_helmet'))
      .sort((a, b) => tierOf(b.name) - tierOf(a.name))
    const best = candidates[0]
    if (best && (!current || tierOf(best.name) > tierOf(current.name))) {
      await bot.equip(best, destination)
      equipped.push(best.name)
    }
  }
  return equipped
}

export function bestFood(bot: Bot): Item | undefined {
  const foods = bot.registry.foodsByName
  const avoid = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])
  return bot.inventory.items()
    .filter(item => foods[item.name] && !avoid.has(item.name))
    .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0]
}
