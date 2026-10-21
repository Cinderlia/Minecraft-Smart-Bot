import { loader as pathfinderLoader } from '@miner-org/mineflayer-baritone'
import { Agent } from './agent/agent.js'
import { ChatSpeaker } from './agent/chat.js'
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

/** Rough heuristic: action verbs mark a task; everything else is chat. */
function looksLikeTask(message: string): boolean {
  const m = message.toLowerCase()
  return /(拿|给|做|建|搭|挖|砍|种|收|放|拆|清除|合成|熔炼|传送|攻击|打|找|去|过来|come|go|get|give|make|build|mine|craft|smelt|place|remove|clear|attack|find)/i.test(m)
}

function main() {
  const config = loadConfig()
  const bot = createBot(config)

  // Install the pathfinder plugin before any navigation can happen.
  bot.loadPlugin(pathfinderLoader)

  const registry = createToolRegistry()
  // Separate LLM clients: chat must never abort or block the agent.
  const agentLlm = new LlmClient(config.llm)
  const chatLlm = new LlmClient(config.llm)
  const speaker = new ChatSpeaker(bot, chatLlm)
  const agent = new Agent(bot, registry, agentLlm, config.agent, speaker)

  log.info(`Loaded ${registry.list().length} tools; model ${config.llm.model}`)

  bot.once('spawn', async () => {
    // Baritone needs chunk data before it can pathfind reliably.
    await bot.waitForChunksToLoad()

    configureMovements(bot)
    if (config.agent.autoEat) enableAutoEat(bot, () => agent.busy)

    listenForOwnerMessages(bot, config.owners, ({ source, username, message }) => {
      log.info(`[${source}] ${username}: ${message}`)
      if (tryHandleCommand(bot, agent, message)) return

      if (agent.busy) {
        log.info(`[route] busy → chat (${agent.currentTaskDescription() ?? 'unknown'})`)
        speaker.speak(message, { busyWith: agent.currentTaskDescription() })
        return
      }
      if (looksLikeTask(message)) {
        log.info('[route] task → agent')
        agent.submit({ username, message })
      } else {
        log.info('[route] chat → speaker')
        speaker.speak(message, { busyWith: null })
      }
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