import { Bot } from 'mineflayer'
import { createLogger } from '../util/logger.js'
import { bestFood } from './inventory.js'

const log = createLogger('behaviors')
const hungerThreshold = 14
/** Minimum gap between auto-eat attempts, so a stale food value doesn't trigger a loop. */
const eatCooldownMs = 5000

/**
 * Eat automatically when hungry, but only while idle so it never swaps the
 * held item in the middle of a task.
 */
export function enableAutoEat(bot: Bot, isBusy: () => boolean) {
  let eating = false
  let lastEat = 0

  bot.on('health', async () => {
    if (eating || isBusy() || bot.food >= hungerThreshold) return
    if (Date.now() - lastEat < eatCooldownMs) return

    const food = bestFood(bot)
    if (!food) {
      if (bot.food < hungerThreshold) {
        log.warn(`Still hungry (food ${bot.food}) but no edible food in inventory`)
      }
      return
    }
    // Guard against bestFood returning something the bot cannot actually consume.
    if (!bot.registry.foodsByName?.[food.name]) {
      log.debug(`Skipping ${food.name}: not a consumable food`)
      return
    }

    eating = true
    lastEat = Date.now()
    const previous = bot.heldItem
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
      log.info(`Auto-ate ${food.name} (food now ${bot.food})`)
    } catch (error) {
      log.debug('Auto-eat failed', error)
    } finally {
      if (previous && previous !== food) {
        await bot.equip(previous, 'hand').catch(() => {})
      }
      eating = false
    }
  })
}