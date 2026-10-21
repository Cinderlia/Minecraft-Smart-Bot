import { Bot } from 'mineflayer'
import { LlmClient, Message } from './llm.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('chat')

/** Persona is intentionally short: enough to sound human, not enough to leak into task logic. */
const PERSONA = `You are sbot, a Minecraft player who helps friends on a creative server.
Personality: friendly, a bit playful, concise. You talk like a real player in chat, not like a log or a manual.
Rules:
- Reply in ONE short chat line (under 120 characters when possible).
- Never mention plans, steps, tool names, coordinates or internal state unless the player asked for them.
- Never use markdown, bullet points or headers.
- If you are busy with a task, say so briefly in natural language (e.g. "on it, give me a sec").
- Match the player's language (Chinese in → Chinese out).
- Do not invent facts about the world; if you don't know, say so casually.`

export type ChatContext = {
  /** What the bot is doing right now, in plain words, or null when idle. */
  busyWith: string | null
  /** Optional: a completed task result to report naturally. */
  report?: string
}

/**
 * Turns task results and small talk into short, in-character chat lines.
 * Uses its own LlmClient so it never aborts or blocks the agent's planning.
 */
export class ChatSpeaker {
  constructor(private readonly bot: Bot, private readonly llm: LlmClient) {}

  /** Fire-and-forget: never awaits the LLM in the caller's task loop. */
  speak(userMessage: string, ctx: ChatContext): void {
    void this.generate(userMessage, ctx)
      .then(line => {
        if (line) this.bot.chat(line.slice(0, 200))
      })
      .catch(error => log.debug('Chat generation failed', error))
  }

  private async generate(userMessage: string, ctx: ChatContext): Promise<string> {
    const parts: string[] = []
    if (ctx.busyWith) parts.push(`You are currently busy: ${ctx.busyWith}.`)
    else parts.push('You are currently idle.')
    if (ctx.report) parts.push(`Something just finished, report it naturally: ${ctx.report}`)
    parts.push(`Player said: ${userMessage}`)
    parts.push('Reply with one short in-character chat line.')

    const messages: Message[] = [
      { role: 'system', content: PERSONA },
      { role: 'user', content: parts.join('\n') }
    ]

    try {
      const response = await this.llm.chat(messages, [])
      return response.content.trim()
    } catch (error) {
      log.debug('Chat LLM error', error)
      return ''
    }
  }
}