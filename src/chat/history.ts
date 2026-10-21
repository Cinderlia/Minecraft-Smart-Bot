import { Bot } from 'mineflayer'
import { createLogger } from '../util/logger.js'

const log = createLogger('chat-history')

export type ChatEntry = {
  id: number
  time: number
  /** 'player' or 'system' or 'bot'. */
  kind: 'player' | 'system' | 'bot'
  username: string
  message: string
}

const MAX_ENTRIES = 20

export class ChatHistory {
  private entries: ChatEntry[] = []
  private nextId = 1

  add(kind: ChatEntry['kind'], username: string, message: string): ChatEntry {
    const entry: ChatEntry = {
      id: this.nextId++,
      time: Date.now(),
      kind,
      username,
      message: message.trim()
    }
    this.entries.push(entry)
    while (this.entries.length > MAX_ENTRIES) this.entries.shift()
    return entry
  }

  /** All entries, oldest first. */
  all(): ChatEntry[] {
    return [...this.entries]
  }

  /** Compact rendering for the language-loop prompt. */
  render(): string {
    return this.entries
      .map(e => {
        const t = new Date(e.time).toISOString().slice(11, 19)
        return `#${e.id} ${t} [${e.kind}] ${e.username}: ${e.message}`
      })
      .join('\n')
  }
}

/**
 * Subscribe to the bot's public chat and record:
 * - player chat (`bot.on('chat')`)
 * - system / server messages (`bot.on('messagestr')` that are not player chat)
 * - the bot's own chat is recorded explicitly by ChatSpeaker via `history.add('bot', ...)`.
 */
export function attachChatHistory(bot: Bot, history: ChatHistory) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return // bot's own messages are recorded by the speaker
    history.add('player', username, message)
  })
  bot.on('messagestr', (message, position) => {
    if (position === 'chat') return // already captured by the chat listener above
    history.add('system', position ?? 'server', message)
  })
  log.info('chat history attached')
}