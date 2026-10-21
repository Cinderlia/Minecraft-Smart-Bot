import { Bot } from 'mineflayer'
import { describeWorldState } from '../bot/status.js'
import { ChatHistory } from '../chat/history.js'
import { createLogger } from '../util/logger.js'
import { LlmClient, Message } from './llm.js'

const log = createLogger('autonomic')

const SYSTEM = `You are a Minecraft player. You will be given the current chat, your character's state (health, inventory, game mode), and the world around you (blocks, entities, time, weather). Decide what to do to pass the next ten minutes in a meaningful way.

The recent chat includes your own recent actions labelled [system] sbot: finished task: ... — do not repeat something you just finished.

Reply with ONE short line describing your next goal, in the player's language. The goal must be:
- Concrete and specific (what, where, roughly how), not vague.
- Realistic for the current situation: check your inventory, game mode, surroundings and the recent chat before deciding. In creative mode you do not need to gather materials for gear; if the area is cramped, do not plan to build a house there; if it is night, do not wander into the open.
- Something you can start right now and plausibly finish or make progress on in ~10 minutes.
- Based on the situation, not on examples. There are no example goals.
- Before deciding, ask yourself: is this worth doing at all, or am I just filling time? If the honest answer is "just filling time", pick something with a visible result instead.
- The goal should produce a visible change in the world or inventory that you could point at in ten minutes.

Reply with the goal only, in one or two short sentences. No prefix, no quotes, no markdown.`

export async function decideNextGoal(
  bot: Bot,
  llm: LlmClient,
  history: ChatHistory
): Promise<string | null> {
  const context = [
    `Recent chat (oldest first, you are ${bot.username}):`,
    history.render() || '(empty)',
    ``,
    `Your state:\n${describeWorldState(bot)}`
  ].join('\n')

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: context }
  ]

  try {
    const response = await llm.chat(messages, [])
    const text = response.content.trim().replace(/^["'`]+|["'`]+$/g, '')
    if (!text) return null
    log.info(`[autonomic] decided: ${text.slice(0, 200)}`)
    return text
  } catch (error) {
    log.debug('autonomic LLM error', error)
    return null
  }
}