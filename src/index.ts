import { loader as pathfinderLoader } from '@miner-org/mineflayer-baritone'
import { Agent } from './agent/agent.js'
import { LlmClient } from './agent/llm.js'
import { enableAutoEat } from './bot/behaviors.js'
import { configureMovements } from './bot/navigation.js'
import { createBot } from './bot/createBot.js'
import { tryHandleCommand } from './chat/commands.js'
import { listenForOwnerMessages } from './chat/listener.js'
import { loadConfig } from './config.js'
import { createToolRegistry } from './tools/registry.js'
import { createLogger } from './util/logger.js'

const log = createLogger('main')

function main() {
  const config = loadConfig()
  const bot = createBot(config)

  // Install the pathfinder plugin before any navigation can happen.
  bot.loadPlugin(pathfinderLoader)

  const registry = createToolRegistry()
  const agent = new Agent(bot, registry, new LlmClient(config.llm), config.agent)

  log.info(`Loaded ${registry.list().length} tools; model ${config.llm.model}`)

  bot.once('spawn', async () => {
    // Baritone needs chunk data before it can pathfind reliably.
    await bot.waitForChunksToLoad()

    configureMovements(bot)
    if (config.agent.autoEat) enableAutoEat(bot, () => agent.busy)

    listenForOwnerMessages(bot, config.owners, ({ source, username, message }) => {
      log.info(`[${source}] ${username}: ${message}`)
      if (tryHandleCommand(bot, agent, message)) return
      agent.submit({ username, message })
    })
  })

  bot.on('end', () => {
    agent.cancel()
  })
  process.on('SIGINT', () => {
    agent.cancel()
    bot.quit()
    process.exit(0)
  })
}

main()