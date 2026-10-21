import { Bot } from 'mineflayer'
import { Entity } from 'prismarine-entity'
import { bestWeapon, describeInventoryChange, snapshotInventory } from '../bot/inventory.js'
import { goals } from '../bot/goals.js'
import { entityLabel, findEntity, isHostile, nearbyEntities } from '../bot/world.js'
import { sleep, throwIfAborted } from '../util/async.js'
import { ToolInputError } from './args.js'
import { pickUpDrops } from './gathering.js'
import { defineTool } from './types.js'

const category = 'Combat'
const lowHealth = 6

function isAlive(bot: Bot, entity: Entity): boolean {
  return entity.isValid && bot.entities[entity.id] === entity
}

export type FightResult = 'killed' | 'escaped' | 'unreachable' | 'low_health' | 'timeout'

/**
 * Chase and hit an entity until it dies, the bot gets too hurt, or it gets dragged
 * more than `leash` blocks from where the fight started (so it doesn't follow a
 * skeleton deep into a cave).
 *
 * Baritone has no dynamic follow goal, so we re-issue a short goto each tick.
 */
export async function fight(bot: Bot, entity: Entity, signal: AbortSignal, timeoutMs: number, leash = 20): Promise<FightResult> {
  const weapon = bestWeapon(bot)
  if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')

  const start = bot.entity.position.clone()
  const deadline = Date.now() + timeoutMs
  let lastHit = 0
  let lastProgress = Date.now()
  let navigating = false

  try {
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (!isAlive(bot, entity)) return 'killed'
      if (bot.health <= lowHealth) return 'low_health'
      const distance = bot.entity.position.distanceTo(entity.position)
      if (distance > 32 || entity.position.distanceTo(start) > leash) return 'escaped'
      if (Date.now() - lastProgress > 15_000) return 'unreachable'

      // Respect the attack cooldown (~0.6s for swords) so hits do full damage.
      if (distance <= 3.2 && Date.now() - lastHit >= 650) {
        await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true)
        bot.attack(entity)
        lastHit = lastProgress = Date.now()
      } else if (distance > 3.2 && !navigating) {
        // Re-issue a short chase goal without blocking the loop.
        navigating = true
        void bot.ashfinder.gotoSmart(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2), { waypointThreshold: 10, forceAdaptive: true })
          .catch(() => {})
          .finally(() => { navigating = false })
      }
      await sleep(100, signal)
    }
    return 'timeout'
  } finally {
    bot.ashfinder.stop()
  }
}

export const combatTools = [
  defineTool({
    name: 'attack',
    category,
    description:
      'Fight a mob or player with the best weapon available, chasing it until it dies. Can repeat for several of the same mob ' +
      '(e.g. hunt 3 cows for food). Use target "hostile" for the nearest monster. Picks up drops afterwards. Stops if health gets low.',
    params: {
      target: { type: 'string', description: 'Mob name ("zombie", "cow"), player username, or "hostile"', required: true },
      count: { type: 'integer', description: 'How many to kill (default 1, max 10)' }
    },
    async handler(args, { bot, signal, requester }) {
      const target = args.string('target')
      if (target.toLowerCase() === requester.toLowerCase()) throw new ToolInputError('Refusing to attack the player giving me orders')
      const count = args.int('count', 1, { min: 1, max: 10 })
      const before = snapshotInventory(bot)
      let kills = 0
      let outcome = ''

      while (kills < count) {
        const entity = findEntity(bot, target, 24)
        if (!entity) {
          outcome = kills === 0 ? `No ${target} within 24 blocks.` : `No more ${target} nearby.`
          break
        }
        const result = await fight(bot, entity, signal, 45_000)
        if (result !== 'killed') {
          outcome = result === 'low_health' ? 'Stopped: health is low.' : `Stopped: target ${result}.`
          break
        }
        kills++
        await pickUpDrops(bot, entity.position, 6, signal)
      }

      if (kills === 0 && outcome) throw new ToolInputError(outcome)
      return `Killed ${kills} ${target}. ${outcome} Inventory change: ${describeInventoryChange(before, snapshotInventory(bot))}`.trim()
    }
  }),

  defineTool({
    name: 'defend',
    category,
    description:
      'Fight every hostile mob within a radius until the area is clear, staying near the current spot. ' +
      'Use this for "protect yourself" / "defend me"; it will not chase mobs far away or into caves.',
    params: {
      radius: { type: 'number', description: 'Radius to clear (default 16)' }
    },
    async handler(args, { bot, signal }) {
      const radius = args.optionalNumber('radius', { min: 4, max: 32 }) ?? 16
      const killed: string[] = []
      const gaveUp = new Set<number>()
      for (let i = 0; i < 15; i++) {
        const enemy = nearbyEntities(bot, radius).find(e => isHostile(e) && !gaveUp.has(e.id))
        if (!enemy) break
        const result = await fight(bot, enemy, signal, 30_000, radius + 4)
        if (result === 'low_health') return `Retreat advised: health ${Math.round(bot.health)}/20. Killed: ${killed.join(', ') || 'none'}`
        if (result === 'killed') killed.push(entityLabel(enemy))
        else gaveUp.add(enemy.id)
      }
      const skipped = gaveUp.size > 0 ? ` Left ${gaveUp.size} mob(s) that were out of reach.` : ''
      return killed.length > 0 ? `Area clear. Killed: ${killed.join(', ')}.${skipped}` : `No reachable hostile mobs nearby.${skipped}`
    }
  })
]