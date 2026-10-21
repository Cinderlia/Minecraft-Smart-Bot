import { Bot } from 'mineflayer'
import { Block } from 'prismarine-block'
import { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { ToolInputError } from '../tools/args.js'

type NamedDef = { id: number; name: string; displayName: string }

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')
}

function lookup<T extends NamedDef>(byName: Record<string, T>, raw: string): T | undefined {
  const name = normalizeName(raw)
  return byName[name]
    ?? (name.endsWith('es') ? byName[name.slice(0, -2)] : undefined)
    ?? (name.endsWith('s') ? byName[name.slice(0, -1)] : undefined)
    ?? byName[`${name}s`]
}

function suggestions(names: string[], raw: string, limit = 8): string {
  const term = normalizeName(raw).replace(/s$/, '')
  const matches = names.filter(n => n.includes(term)).slice(0, limit)
  return matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : ''
}

export function resolveItem(bot: Bot, raw: string) {
  const item = lookup(bot.registry.itemsByName, raw)
  if (!item) {
    throw new ToolInputError(`Unknown item "${raw}".${suggestions(Object.keys(bot.registry.itemsByName), raw)}`)
  }
  return item
}

export function resolveBlock(bot: Bot, raw: string) {
  const block = lookup(bot.registry.blocksByName, raw)
  if (!block) {
    throw new ToolInputError(`Unknown block "${raw}".${suggestions(Object.keys(bot.registry.blocksByName), raw)}`)
  }
  return block
}

const blockAliases: Record<string, (name: string) => boolean> = {
  wood: n => n.endsWith('_log') && !n.startsWith('stripped_'),
  log: n => n.endsWith('_log') && !n.startsWith('stripped_'),
  tree: n => n.endsWith('_log') && !n.startsWith('stripped_'),
  planks: n => n.endsWith('_planks'),
  leaves: n => n.endsWith('_leaves'),
  ore: n => n.endsWith('_ore'),
  sand: n => n === 'sand' || n === 'red_sand',
  dirt: n => n === 'dirt' || n === 'grass_block' || n === 'coarse_dirt' || n === 'rooted_dirt',
  stone: n => n === 'stone',
  cobblestone: n => n === 'cobblestone' || n === 'stone',
  water: n => n === 'water',
  lava: n => n === 'lava',
  bed: n => n.endsWith('_bed'),
  wool: n => n.endsWith('_wool'),
  crop: n => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(n),
  farm: n => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(n),
  flower: n => ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'].includes(n) || n.endsWith('_tulip')
}

/**
 * Turn a loose block description ("wood", "iron", "diamond ore", "oak_log")
 * into every concrete block id it could reasonably mean. Ores include their
 * deepslate variants so the bot finds them at any depth.
 */
export function resolveBlockFamily(bot: Bot, raw: string): { ids: number[]; names: string[] } {
  const byName = bot.registry.blocksByName
  const all = Object.keys(byName)
  const name = normalizeName(raw)
  const candidates = [...new Set([name, name.replace(/es$/, ''), name.replace(/s$/, ''), `${name}s`])]

  const strategies: Array<(c: string) => string[]> = [
    c => (blockAliases[c] ? all.filter(blockAliases[c]) : []),
    c => {
      if (!byName[c]) return []
      return c.endsWith('_ore') && byName[`deepslate_${c}`] ? [c, `deepslate_${c}`] : [c]
    },
    c => [`${c}_ore`, `deepslate_${c}_ore`].filter(n => byName[n]),
    c => all.filter(n => n.endsWith(`_${c}`))
  ]

  for (const strategy of strategies) {
    for (const candidate of candidates) {
      const names = strategy(candidate)
      if (names.length > 0) return { ids: names.map(n => byName[n].id), names }
    }
  }

  throw new ToolInputError(`Unknown block "${raw}".${suggestions(all, raw)}`)
}

export function formatPos(pos: Vec3): string {
  return `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`
}

export function distanceTo(bot: Bot, pos: Vec3): number {
  return bot.entity.position.distanceTo(pos)
}

export function entityLabel(entity: Entity): string {
  if (entity.type === 'player') return entity.username ?? 'player'
  if (entity.name === 'item') {
    const item = entity.getDroppedItem()
    return item ? `dropped ${item.name} x${item.count}` : 'dropped item'
  }
  return entity.name ?? entity.displayName ?? entity.type
}

export function nearbyEntities(bot: Bot, maxDistance: number): Entity[] {
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= maxDistance)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

const hostileCategory = new Set(['hostile', 'Hostile mobs'])

export function isHostile(entity: Entity): boolean {
  return entity.type === 'hostile' || hostileCategory.has(String(entity.kind))
}

/** Find the nearest entity matching a player username, mob name ("zombie") or "hostile". */
export function findEntity(bot: Bot, target: string, maxDistance = 32): Entity | null {
  const term = normalizeName(target)
  const player = Object.values(bot.players).find(p => p.username.toLowerCase() === target.trim().toLowerCase())
  if (player?.entity) return player.entity

  return nearbyEntities(bot, maxDistance).find(e => {
    if (term === 'hostile' || term === 'monster' || term === 'mob') return isHostile(e)
    return e.name === term || e.name === term.replace(/s$/, '')
  }) ?? null
}

export function findNearestBlock(bot: Bot, ids: number[], maxDistance = 64): Block | null {
  return bot.findBlock({ matching: ids, maxDistance })
}

/** Air positions next to the bot where a block could be placed (solid ground below, not inside the bot). */
export function findPlaceableSpot(bot: Bot): Vec3 | null {
  const base = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]]
  for (const [dx, dz] of offsets) {
    const pos = base.offset(dx, 0, dz)
    const block = bot.blockAt(pos)
    const below = bot.blockAt(pos.offset(0, -1, 0))
    if (block?.name === 'air' && below && below.boundingBox === 'block') return pos
  }
  return null
}

/** A solid neighbour of `target` that a block can be placed against, plus the face to click. */
export function findPlacementReference(bot: Bot, target: Vec3): { reference: Block; face: Vec3 } | null {
  const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  for (const dir of faces) {
    const reference = bot.blockAt(target.plus(dir))
    if (reference && reference.boundingBox === 'block') {
      return { reference, face: dir.scaled(-1) }
    }
  }
  return null
}

export function isOwnerOnline(bot: Bot, owners: string[]): boolean {
  const players = bot.players ?? {}
  const online = new Set(Object.keys(players).map(n => n.toLowerCase()))
  return owners.some(o => online.has(o.toLowerCase()))
}