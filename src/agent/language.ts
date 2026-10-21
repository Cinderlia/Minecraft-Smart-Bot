import { Bot } from 'mineflayer'
import { describeWorldState } from '../bot/status.js'
import { createLogger } from '../util/logger.js'
import { BodyLoop } from './body.js'
import { ChatSpeaker } from './chat.js'
import { LlmClient, Message } from './llm.js'

const log = createLogger('language')

/** Rolling chat log: only the last N lines are fed to the language LLM. */
const MAX_CHAT_LINES = 20

type ChatLine = { time: number; username: string; message: string }

const SYSTEM = `You are the language controller for a Minecraft bot. You see recent chat, the bot state, and the body task queue. Decide what to do for the newest player message.

Reply with ONE tool call:
- "say" { message } — talk back to the player. Use when the message is directed at you, or you want to chime in.
- "enqueue_task" { request, priority } — start a body task. request is the player's own words, unedited. priority: 10 = urgent, 0 = normal, -10 = background.
- "cancel_task" { id } — remove a queued or running task.
- "set_priority" { id, priority } — change a task's priority.

Rules:
- Do NOT invent tasks the player did not ask for.
- Do NOT enqueue a task for pure small talk.
- If the player asks for progress, use "say" and summarise from the queue state.
- Keep "say" replies short, in character, and in the player's language.`

export class LanguageLoop {
  private history: ChatLine[] = []

  constructor(
    private readonly bot: Bot,
    private readonly llm: LlmClient,
    private readonly body: BodyLoop,
    private readonly speaker: ChatSpeaker
  ) {}

  /** Called for every owner message. */
  async handle(username: string, message: string): Promise<void> {
    this.history.push({ time: Date.now(), username, message })
    while (this.history.length > MAX_CHAT_LINES) this.history.shift()

    const context = [
      `Recent chat (oldest first):`,
      ...this.history.map(l => `${l.username}: ${l.message}`),
      ``,
      `Bot state:\n${describeWorldState(this.bot)}`,
      ``,
      `Body queue:\ncurrent=${JSON.stringify(this.body.snapshot().current)}\nqueued=${JSON.stringify(this.body.snapshot().queued)}`
    ].join('\n')

    const tools = this.buildTools()
    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context }
    ]

    const response = await this.llm.chat(messages, tools)
    const calls = response.tool_calls ?? []
    if (calls.length === 0) {
      log.warn(`language loop produced no tool call for "${message}"`)
      return
    }
    for (const call of calls) {
      const name = call.function.name
      const args = (call.function.arguments ?? {}) as Record<string, any>
      log.info(`[language] ${name} ${JSON.stringify(args)}`)
      if (name === 'say') {
        this.speaker.speak(message, { busyWith: this.body.currentTaskDescription(), report: args.message })
      } else if (name === 'enqueue_task') {
        this.body.enqueue({ username, message: String(args.request ?? message), priority: Number(args.priority ?? 0) })
      } else if (name === 'cancel_task') {
        this.body.cancel(String(args.id ?? ''))
      } else if (name === 'set_priority') {
        this.body.setPriority(String(args.id ?? ''), Number(args.priority ?? 0))
      }
    }
  }

  private buildTools() {
    return [
      {
        type: 'function' as const,
        function: {
          name: 'say',
          description: 'Reply to the player in chat.',
          parameters: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'enqueue_task',
          description: 'Start a body task from the player request.',
          parameters: {
            type: 'object',
            required: ['request'],
            properties: {
              request: { type: 'string', description: "The player's own words, unedited" },
              priority: { type: 'integer', description: '10 urgent, 0 normal, -10 background' }
            }
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'cancel_task',
          description: 'Cancel a task by id.',
          parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'set_priority',
          description: 'Change a task priority.',
          parameters: {
            type: 'object',
            required: ['id', 'priority'],
            properties: { id: { type: 'string' }, priority: { type: 'integer' } }
          }
        }
      }
    ]
  }
}