import { Bot } from 'mineflayer'
import { LlmClient, Message } from './llm.js'
import { createLogger } from '../util/logger.js'
import { ChatHistory } from '../chat/history.js'

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
- When reporting a finished task, summarize the OUTCOME in natural language ("搞定，镐子丢你脚下了"), not the steps ("[1] done | [2] done").
- If the purpose is just "task finished", say something natural and short based on what you were doing; do not repeat the phrase the bot used last time.
- Use the recent chat as context so the reply fits the flow; do not echo the purpose text or the task summary verbatim.
- Do not invent facts about the world; if you don't know, say so casually.`

export type ChatContext = {
  /** What the bot is doing right now, in plain words, or null when idle. */
  busyWith: string | null
  /** A short purpose to convey (not the exact message). */
  report?: string
}

/**
 * Turns purposes into short, in-character chat lines, using the recent chat as
 * context so replies do not read like a machine repeating a summary.
 */
export class ChatSpeaker {
  constructor(
    private readonly bot: Bot,
    private readonly llm: LlmClient,
    private readonly history?: ChatHistory
  ) {}

  /** Fire-and-forget: never awaits the LLM in the caller's task loop. */
  speak(userMessage: string, ctx: ChatContext): void {
    log.info(`← ${userMessage} | busy: ${ctx.busyWith ?? 'idle'}${ctx.report ? ` | purpose: ${ctx.report.slice(0, 80)}` : ''}`)
    void this.generate(userMessage, ctx)
      .then(line => {
        if (line) {
          log.info(`→ ${line}`)
          this.bot.chat(line.slice(0, 200))
          this.history?.add('bot', this.bot.username, line)
        } else {
          log.warn('Chat generation returned empty; nothing sent')
        }
      })
      .catch(error => log.error('Chat generation failed', error))
  }

  private async generate(userMessage: string, ctx: ChatContext): Promise<string> {
    const parts: string[] = []
    if (this.history) parts.push(`Recent chat (oldest first):\n${this.history.render() || '(empty)'}`)
    if (ctx.busyWith) parts.push(`You are currently busy: ${ctx.busyWith}.`)
    else parts.push('You are currently idle.')
    if (ctx.report) parts.push(`What to convey (paraphrase, do not copy): ${ctx.report}`)
    parts.push(`Last player message: ${userMessage}`)
    parts.push('Reply with one short in-character chat line that fits the recent chat and does not repeat the last bot line.')

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