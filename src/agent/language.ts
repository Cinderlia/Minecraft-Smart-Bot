import { Bot } from 'mineflayer'
import { describeWorldState } from '../bot/status.js'
import { createLogger } from '../util/logger.js'
import { BodyLoop } from './body.js'
import { ChatHistory } from '../chat/history.js'
import { LlmClient } from './llm.js'

const log = createLogger('language')

type ChatIntent = { taskId: string; reason: string; intent: string }

const SYSTEM = `You are sbot, a Minecraft player who helps friends on a creative server. You see recent public chat, the bot state, and the body task queue, and you decide what to do for the newest player message.

Reply with exactly ONE tool call. The "message" field is what gets sent to chat VERBATIM — write it as sbot's own line, short (under 120 chars), in the player's language, in character (friendly, a bit playful, concise). Never use markdown.

Tools:
- "say" { message } — just reply in chat.
- "enqueue_task" { request, message, priority } — start a body task AND send the acknowledgement in the same call. request = the player's own words, unedited.
- "cancel_task" { id, message } — cancel a task and say why.
- "set_priority" { id, priority, message } — change a task priority and say why.
- "silent" {} — do nothing.

Rules:
- Do NOT invent tasks the player did not ask for.
- Do NOT enqueue a task for pure small talk or for things the bot cannot do in Minecraft (e.g. "擦皮鞋"); decline playfully with "say" instead.
- The task queue lists each task's description, the original player request that triggered it, and its progress. If a request is already in the queue (same "triggered by" text), do NOT enqueue it again.
- Fit the recent chat: do not repeat the last bot line, and keep the flow natural.
- Use "silent" when the message needs no reply and no task.`

export class LanguageLoop {
  constructor(
    private readonly bot: Bot,
    private readonly llm: LlmClient,
    private readonly body: BodyLoop,
    private readonly history: ChatHistory
  ) {}

  async handle(username: string, message: string): Promise<void> {
    const response = await this.llm.chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: this.buildContext() }
      ],
      this.buildTools()
    )

    const calls = response.tool_calls ?? []
    if (calls.length === 0) {
      log.warn(`language loop produced no tool call for "${message}"`)
      return
    }
    for (const call of calls) {
      this.applyToolCall(call.function.name, (call.function.arguments ?? {}) as Record<string, any>, username, message)
    }
  }

  /** Task finished / task needs a chat line: generate one line in-context, send it. */
  async forceReply(intent: ChatIntent): Promise<void> {
    const context =
      this.buildContext() +
      '\n' +
      [
        'A running task needs you to speak now:',
        `  task: ${intent.taskId}`,
        `  reason: ${intent.reason}`,
        `  intent: ${intent.intent}`,
        'Reply with a short "say" whose message fits the recent chat and does not repeat the last bot line.'
      ].join('\n')

    const response = await this.llm.chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: context }
      ],
      this.buildTools()
    )

    for (const call of response.tool_calls ?? []) {
      const name = call.function.name
      const args = (call.function.arguments ?? {}) as Record<string, any>
      log.info(`[language:force] ${name} ${JSON.stringify(args)}`)
      if (name === 'say') this.sendChat(String(args.message ?? ''))
    }
  }

  private sendChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    log.info(`→ ${trimmed}`)
    this.bot.chat(trimmed.slice(0, 200))
    this.history.add('bot', this.bot.username, trimmed)
  }

  private buildContext(): string {
    const snap = this.body.snapshot()
    const queueLines: string[] = []
    if (snap.current) {
      queueLines.push(
        `  CURRENT ${snap.current.id} [${snap.current.progress}] "${snap.current.description}" ← triggered by: ${snap.current.request}`
      )
    }
    for (const t of snap.queued) {
      queueLines.push(`  QUEUED  ${t.id} p=${t.priority} [${t.progress}] "${t.description}" ← triggered by: ${t.request}`)
    }
    const queueText = queueLines.length > 0 ? queueLines.join('\n') : '  (empty)'

    return [
      `Recent chat (oldest first, max 20):`,
      this.history.render() || '(empty)',
      ``,
      `Task queue:`,
      queueText,
      ``,
      `Bot state:\n${describeWorldState(this.bot)}`
    ].join('\n')
  }

  private applyToolCall(name: string, args: Record<string, any>, username: string, originalMessage: string) {
    log.info(`[language] ${name} ${JSON.stringify(args)}`)
    if (name === 'say') {
      this.sendChat(String(args.message ?? ''))
    } else if (name === 'enqueue_task') {
      this.body.enqueue({
        username,
        message: String(args.request ?? originalMessage),
        priority: Number(args.priority ?? 0)
      })
      this.sendChat(String(args.message ?? ''))
    } else if (name === 'cancel_task') {
      this.body.cancel(String(args.id ?? ''))
      this.sendChat(String(args.message ?? ''))
    } else if (name === 'set_priority') {
      this.body.setPriority(String(args.id ?? ''), Number(args.priority ?? 0))
      this.sendChat(String(args.message ?? ''))
    } else if (name === 'silent') {
      // no-op
    }
  }

  private buildTools(): any[] {
    return [
      {
        type: 'function' as const,
        function: {
          name: 'say',
          description: 'Reply in chat. message is sent verbatim.',
          parameters: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'enqueue_task',
          description: 'Start a body task and acknowledge it in the same call.',
          parameters: {
            type: 'object',
            required: ['request', 'message'],
            properties: {
              request: { type: 'string', description: "The player's own words, unedited" },
              message: { type: 'string', description: 'A short line to say to the player' },
              priority: { type: 'integer', description: '10 urgent, 0 normal, -10 background' }
            }
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'cancel_task',
          description: 'Cancel a task and say why.',
          parameters: {
            type: 'object',
            required: ['id', 'message'],
            properties: { id: { type: 'string' }, message: { type: 'string' } }
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'set_priority',
          description: 'Change a task priority and say why.',
          parameters: {
            type: 'object',
            required: ['id', 'priority', 'message'],
            properties: { id: { type: 'string' }, priority: { type: 'integer' }, message: { type: 'string' } }
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'silent',
          description: 'Do nothing.',
          parameters: { type: 'object', properties: {} }
        }
      }
    ]
  }
}