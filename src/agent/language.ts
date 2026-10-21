import { Bot } from 'mineflayer'
import { describeWorldState } from '../bot/status.js'
import { createLogger } from '../util/logger.js'
import { BodyLoop } from './body.js'
import { ChatHistory } from '../chat/history.js'
import { ChatSpeaker } from './chat.js'
import { LlmClient, Message } from './llm.js'

const log = createLogger('language')

type ChatIntent = { taskId: string; reason: string; intent: string }

const SYSTEM = `You are the language controller for a Minecraft bot. You see recent public chat, the bot state, and the body task queue. Decide what to do for the newest player message.

Reply with ONE tool call:
- "say" { message } — talk back to the player. Use when the message is directed at you, or you want to chime in.
- "enqueue_task" { request, priority } — start a body task. request is the player's own words, unedited. priority: 10 = urgent, 0 = normal, -10 = background.
- "cancel_task" { id } — remove a queued or running task.
- "set_priority" { id, priority } — change a task's priority.

Rules:
- Do NOT invent tasks the player did not ask for.
- Do NOT enqueue a task for pure small talk.
- The task queue lists each task's description, the original player request that triggered it, and its progress. If a request is already in the queue (same "triggered by" text), do NOT enqueue it again.
- If the player asks for progress, use "say" and summarise from the queue state.
- Keep "say" replies short, in character, and in the player's language.`

export class LanguageLoop {
  constructor(
    private readonly bot: Bot,
    private readonly llm: LlmClient,
    private readonly body: BodyLoop,
    private readonly speaker: ChatSpeaker,
    private readonly history: ChatHistory
  ) {}

  /** Called for every owner message. */
  async handle(username: string, message: string): Promise<void> {
    const context = this.buildContext()
    const response = await this.llm.chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: context }
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

  /**
   * Called by the body loop when a running task asks the language loop to say
   * something. Same context, but the trigger is a task intent, not a chat line.
   */
  async forceReply(intent: ChatIntent): Promise<void> {
    const context = this.buildContext() + [
      '',
      'A running task requested you speak:',
      `  task: ${intent.taskId}`,
      `  reason: ${intent.reason}`,
      `  intent: ${intent.intent}`,
      'Reply with a short "say" that conveys the intent naturally. Do not enqueue a task.'
    ].join('\n')

    const response = await this.llm.chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: context }
      ],
      this.buildTools()
    )

    const calls = response.tool_calls ?? []
    for (const call of calls) {
      const name = call.function.name
      const args = (call.function.arguments ?? {}) as Record<string, any>
      log.info(`[language:force] ${name} ${JSON.stringify(args)}`)
      if (name === 'say') {
        this.speaker.speak(intent.intent, { busyWith: this.body.currentTaskDescription(), report: String(args.message ?? '') })
      }
      // Ignore enqueue/cancel/priority in forced replies — the task loop owns them.
    }
  }

  private buildContext(): string {
    const snap = this.body.snapshot()
    const queueLines: string[] = []
    if (snap.current) {
      queueLines.push(`  CURRENT ${snap.current.id} [${snap.current.progress}] "${snap.current.description}" ← triggered by: ${snap.current.request}`)
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
      this.speaker.speak(originalMessage, { busyWith: this.body.currentTaskDescription(), report: String(args.message ?? '') })
    } else if (name === 'enqueue_task') {
      this.body.enqueue({
        username,
        message: String(args.request ?? originalMessage),
        priority: Number(args.priority ?? 0)
      })
    } else if (name === 'cancel_task') {
      this.body.cancel(String(args.id ?? ''))
    } else if (name === 'set_priority') {
      this.body.setPriority(String(args.id ?? ''), Number(args.priority ?? 0))
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