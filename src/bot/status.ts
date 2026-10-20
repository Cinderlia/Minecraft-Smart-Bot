import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { summarizeInventory, freeSlots } from './inventory.js'
import { entityLabel, formatPos, nearbyEntities } from './world.js'

export function timeOfDayLabel(bot: Bot): string {
  const t = bot.time.timeOfDay
  if (t < 1000) return 'sunrise'
  if (t < 6000) return 'morning'
  if (t < 12000) return 'afternoon'
  if (t < 13000) return 'sunset (beds usable soon)'
  if (t < 23000) return 'night (hostile mobs spawn, beds usable)'
  return 'dawn'
}

export function describeEquipment(bot: Bot): string {
  const slots = bot.inventory.slots
  const parts = [
    `hand: ${bot.heldItem?.name ?? 'empty'}`,
    `off-hand: ${slots[45]?.name ?? 'empty'}`,
    `head: ${slots[5]?.name ?? 'none'}`,
    `chest: ${slots[6]?.name ?? 'none'}`,
    `legs: ${slots[7]?.name ?? 'none'}`,
    `feet: ${slots[8]?.name ?? 'none'}`
  ]
  return parts.join(', ')
}

export function describeStatus(bot: Bot): string {
  const pos = bot.entity.position
  const biome = bot.blockAt(pos)?.biome?.name ?? 'unknown'
  return [
    `Position: ${formatPos(pos)} (${bot.game.dimension}, biome ${biome})`,
    `Health: ${Math.round(bot.health)}/20, Food: ${bot.food}/20, Saturation: ${bot.foodSaturation.toFixed(1)}, Oxygen: ${bot.oxygenLevel}/20`,
    `XP level: ${bot.experience.level}`,
    `Time: ${timeOfDayLabel(bot)} (tick ${bot.time.timeOfDay}), weather: ${bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear'}`,
    `Game mode: ${bot.game.gameMode}`,
    `Equipment: ${describeEquipment(bot)}`
  ].join('\n')
}

/** Blocks treated as empty space (air-like or fluid) when scanning surroundings. */
const TRANSPARENT = new Set([
  'air', 'cave_air', 'void_air',
  'water', 'flowing_water', 'bubble_column',
  'lava', 'flowing_lava'
])

/** Ground-level horizontal reach for "around" scanning. */
const HORIZONTAL_REACH = 3
/** How far down to scan under the bot. */
const BELOW_REACH = 4
/** How far up to scan above the bot (2x). */
const ABOVE_REACH = 8
/** Radius used when reporting the nearest blocks of the current search target. */
const SEARCH_RADIUS = 16
/** Max search-target blocks to report. */
const SEARCH_COUNT = 16
/** Fraction of a bounding box that must be filled for a solid block to count as cubic. */
const CUBIC_FILL_THRESHOLD = 0.75

type Cell = { x: number; y: number; z: number }

/** Absolute bounds of a merged box. */
type Box = { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }

/** Format an absolute box as a compact coordinate range. */
function formatBox(b: Box): string {
  const x = b.x1 === b.x2 ? `${b.x1}` : `${b.x1}..${b.x2}`
  const y = b.y1 === b.y2 ? `${b.y1}` : `${b.y1}..${b.y2}`
  const z = b.z1 === b.z2 ? `${b.z1}` : `${b.z1}..${b.z2}`
  return `(${x}, ${y}, ${z})`
}

/**
 * Greedy 3D box merge for cells of a single block type.
 * Builds axis-aligned boxes, then tries to extend each box upward while the
 * larger box still meets CUBIC_FILL_THRESHOLD of its bounding volume.
 * Returns the covering boxes; holes are reported separately by the caller.
 */
function mergeBoxes(cells: Cell[], threshold = CUBIC_FILL_THRESHOLD): Box[] {
  if (cells.length === 0) return []
  const present = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
  const used = new Set<string>()
  const boxes: Box[] = []

  // Group by y so we can merge per layer first.
  const byY = new Map<number, Cell[]>()
  for (const c of cells) {
    if (!byY.has(c.y)) byY.set(c.y, [])
    byY.get(c.y)!.push(c)
  }
  const ys = [...byY.keys()].sort((a, b) => a - b)

  for (const y of ys) {
    const layer = byY.get(y)!
    // Greedy 2D rectangle merge on this layer (same algorithm as before, absolute coords).
    const byZ = new Map<number, Set<number>>()
    for (const c of layer) {
      if (!byZ.has(c.z)) byZ.set(c.z, new Set())
      byZ.get(c.z)!.add(c.x)
    }
    const zs = [...byZ.keys()].sort((a, b) => a - b)
    for (const z of zs) {
      const xs = [...byZ.get(z)!].sort((a, b) => a - b)
      for (const xStart of xs) {
        const key = `${xStart},${y},${z}`
        if (used.has(key)) continue
        let xEnd = xStart
        while (byZ.get(z)!.has(xEnd + 1) && !used.has(`${xEnd + 1},${y},${z}`)) {
          xEnd++
          used.add(`${xEnd},${y},${z}`)
        }
        used.add(key)
        let zEnd = z
        while (true) {
          const nextZ = zEnd + 1
          const row = byZ.get(nextZ)
          if (!row) break
          let ok = true
          for (let x = xStart; x <= xEnd; x++) {
            if (!row.has(x) || used.has(`${x},${y},${nextZ}`)) { ok = false; break }
          }
          if (!ok) break
          zEnd = nextZ
          for (let x = xStart; x <= xEnd; x++) used.add(`${x},${y},${nextZ}`)
        }
        boxes.push({ x1: xStart, y1: y, z1: z, x2: xEnd, y2: y, z2: zEnd })
      }
    }
  }

  // Try to extend each box upward while the fill ratio stays above threshold.
  const extended: Box[] = []
  for (const box of boxes) {
    let y2 = box.y2
    while (true) {
      const nextY = y2 + 1
      let filled = 0
      let total = 0
      for (let x = box.x1; x <= box.x2; x++) {
        for (let z = box.z1; z <= box.z2; z++) {
          total++
          if (present.has(`${x},${nextY},${z}`)) filled++
        }
      }
      if (total === 0) break
      const ratio = filled / total
      if (ratio < threshold) break
      y2 = nextY
    }
    extended.push({ ...box, y2 })
  }

  return extended
}

/**
 * Rich surroundings snapshot with absolute coordinates.
 * Solid blocks are merged into boxes (allowing ~75% cubic fill); holes inside
 * those boxes are reported separately so the model knows where air pockets are.
 */
export function describeSurroundings(bot: Bot, searchTarget?: string | null): string {
  const p = bot.entity?.position
  if (!p) return 'Surroundings: unknown (no position yet)'

  const lines: string[] = []
  lines.push(`Bot at ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)} (feet, absolute coords). All coordinates below are absolute.`)

  // Collect solid blocks in the scan volume, keyed by block name.
  const byName = new Map<string, Cell[]>()
  let feetAir = false
  let headBlocked = false
  let enclosedHorizontally = true

  for (let dy = -BELOW_REACH; dy <= ABOVE_REACH; dy++) {
    for (let dx = -HORIZONTAL_REACH; dx <= HORIZONTAL_REACH; dx++) {
      for (let dz = -HORIZONTAL_REACH; dz <= HORIZONTAL_REACH; dz++) {
        const wx = Math.floor(p.x) + dx
        const wy = Math.floor(p.y) + dy
        const wz = Math.floor(p.z) + dz
        const block = bot.blockAt(new Vec3(wx, wy, wz))
        if (!block) continue                     // chunk not loaded
        const name = block.name
        const isAir = TRANSPARENT.has(name)

        // Body cells (feet + head) are always air; skip recording them.
        const isBody = dx === 0 && dz === 0 && (dy === 0 || dy === 1)
        if (isBody) continue

        if (dy === -1 && dx === 0 && dz === 0 && isAir) feetAir = true
        if (dy === 1 && dx === 0 && dz === 0 && !isAir) headBlocked = true
        if (dy === 0 && Math.abs(dx) + Math.abs(dz) === 1 && isAir) enclosedHorizontally = false

        if (isAir) continue
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name)!.push({ x: wx, y: wy, z: wz })
      }
    }
  }

  // Merge each block type into boxes and report holes inside those boxes.
  for (const [name, cells] of byName) {
    const present = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
    const boxes = mergeBoxes(cells)
    const filledCells = new Set<string>()
    for (const b of boxes) {
      for (let y = b.y1; y <= b.y2; y++) {
        for (let x = b.x1; x <= b.x2; x++) {
          for (let z = b.z1; z <= b.z2; z++) filledCells.add(`${x},${y},${z}`)
        }
      }
    }
    const holes = cells.length === filledCells.size
      ? []
      : [...filledCells].filter(k => !present.has(k))
    lines.push(`${name}: ${boxes.map(formatBox).join(', ')}`)
    if (holes.length > 0) {
      lines.push(`  ${name} box holes (air/missing inside the merged ranges): ${holes.join('; ')}`)
    }
  }

  if (byName.size === 0) lines.push('All clear (only air/fluids within scan range).')

  // Stuck only when there is no floor or the bot is fully boxed in.
  const stuck = feetAir || (enclosedHorizontally && headBlocked)
  if (stuck) {
    const reasons: string[] = []
    if (feetAir) reasons.push('no solid block under feet')
    if (enclosedHorizontally && headBlocked) reasons.push('boxed in on all sides and above')
    lines.push(`STUCK: ${reasons.join('; ')}. Dig out or move before retrying movement tools.`)
  } else if (enclosedHorizontally) {
    lines.push('NOTE: standing in a 1-block hole (air above, walls around); jump or dig sideways to escape.')
  }

  // Nearest blocks of the active search target, in findBlocks order.
  if (searchTarget) {
    try {
      const positions = bot.findBlocks({ matching: searchTarget as any, maxDistance: SEARCH_RADIUS, count: SEARCH_COUNT })
      if (positions.length === 0) {
        lines.push(`Search target "${searchTarget}": none within ${SEARCH_RADIUS} blocks.`)
      } else {
        const listed = positions.map(pos => `(${pos.x}, ${pos.y}, ${pos.z})`)
        lines.push(`Search target "${searchTarget}" (nearest ${positions.length} within ${SEARCH_RADIUS}): ${listed.join(', ')}`)
      }
    } catch (error) {
      lines.push(`Search target "${searchTarget}": lookup failed (${(error as Error).message}).`)
    }
  }

  return lines.join('\n')
}

/** Compact snapshot sent to the LLM with every request. */
export function describeWorldState(bot: Bot, searchTarget?: string | null): string {
  const entities = nearbyEntities(bot, 24)
    .slice(0, 15)
    .map(e => `${entityLabel(e)} @ ${formatPos(e.position)} (${e.position.distanceTo(bot.entity.position).toFixed(0)}m)`)

  return [
    `## Terrain (absolute coords; use this to compute target coordinates)\n${describeSurroundings(bot, searchTarget)}`,
    describeStatus(bot),
    `Inventory (${freeSlots(bot)} free slots): ${summarizeInventory(bot)}`,
    `Nearby entities: ${entities.length > 0 ? entities.join('; ') : 'none'}`
  ].join('\n')
}