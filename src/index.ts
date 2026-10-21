import { loader as pathfinderLoader } from '@miner-org/mineflayer-baritone'
import { BodyLoop } from './agent/body.js'
import { ChatSpeaker } from './agent/chat.js'
import { LanguageLoop } from './agent/language.js'
import { LlmClient } from './agent/llm.js'
import { enableAutoEat } from './bot/behaviors.js'
import { configureMovements } from './bot/navigation.js'
import { createBot } from './bot/createBot.js'
import { listenForOwnerMessages } from './chat/listener.js'
import { loadConfig } from './config.js'
import { createToolRegistry } from './tools/registry.js'
import { createLogger } from './util/logger.js'

const log = createLogger('main')

function main() {
  const config = loadConfig()
  const bot = createBot(config)
  bot.loadPlugin(pathfinderLoader)

  const registry = createToolRegistry()
  const bodyLlm = new LlmClient(config.llm)
  const languageLlm = new LlmClient(config.llm)
  const chatLlm = new LlmClient(config.llm)
  const speaker = new ChatSpeaker(bot, chatLlm)
  const body = new BodyLoop(bot, registry, bodyLlm, config.agent, speaker)
  const language = new LanguageLoop(bot, languageLlm, body, speaker)

  log.info(`Loaded ${registry.list().length} tools; model ${config.llm.model}`)

  bot.once('spawn', async () => {
    await bot.waitForChunksToLoad()
    configureMovements(bot)
    if (config.agent.autoEat) enableAutoEat(bot, () => body.busy)

    listenForOwnerMessages(bot, config.owners, ({ source, username, message }) => {
      log.info(`[${source}] ${username}: ${message}`)
      void language.handle(username, message).catch(err => log.error('language loop failed', err))
    })
  })

  bot.on('end', () => body.cancelAll())
  process.on('SIGINT', () => { body.cancelAll(); bot.quit(); process.exit(0) })
}

main()