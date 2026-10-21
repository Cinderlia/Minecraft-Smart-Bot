import { loader as pathfinderLoader } from '@miner-org/mineflayer-baritone'
import { BodyLoop, IntentSink } from './agent/body.js'
import { ChatSpeaker } from './agent/chat.js'
import { LanguageLoop } from './agent/language.js'
import { LlmClient } from './agent/llm.js'
import { enableAutoEat } from './bot/behaviors.js'
import { configureMovements } from './bot/navigation.js'
import { createBot } from './bot/createBot.js'
import { attachChatHistory, ChatHistory } from './chat/history.js'
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
  const history = new ChatHistory()
  attachChatHistory(bot, history)

  const bodyLlm = new LlmClient(config.llm)
  const languageLlm = new LlmClient(config.llm)
  const chatLlm = new LlmClient(config.llm)
  const speaker = new ChatSpeaker(bot, chatLlm, history)

  // Deferred wiring: body needs an intent sink that calls language, language needs body.
  let language: LanguageLoop
  const intentSink: IntentSink = (intent) => {
    if (language) void language.forceReply(intent).catch(err => log.error('forceReply failed', err))
  }

  const body = new BodyLoop(bot, registry, bodyLlm, config.agent, speaker, intentSink)
  language = new LanguageLoop(bot, languageLlm, body, history)

  log.info(`Loaded ${registry.list().length} tools; model ${config.llm.model}`)

  bot.once('spawn', async () => {
    await bot.waitForChunksToLoad()
    configureMovements(bot)
    if (config.agent.autoEat) enableAutoEat(bot, () => body.busy)

    listenForOwnerMessages(bot, config.owners, ({ source, username, message }) => {
      // Player messages are recorded by attachChatHistory via bot.on('chat');
      // just route to the language loop.
      log.info(`[${source}] ${username}: ${message}`)
      void language.handle(username, message).catch(err => log.error('language loop failed', err))
    })
  })

  bot.on('end', () => body.cancelAll())
  process.on('SIGINT', () => {
    body.cancelAll()
    bot.quit()
    process.exit(0)
  })
}

main()