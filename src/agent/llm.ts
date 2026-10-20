import { Message, Tool } from 'ollama'
import { Config } from '../config.js'

export type { Message }

/**
 * OpenAI-compatible endpoints return tool_call.function.arguments as a JSON
 * string. Normalize it to an object so the tool registry can read it directly.
 */
function normalizeToolCall(call: any): any {
  const fn = call?.function ?? {}
  let args: Record<string, unknown> = {}
  if (typeof fn.arguments === 'string') {
    try {
      const parsed = JSON.parse(fn.arguments)
      if (parsed && typeof parsed === 'object') args = parsed
    } catch {
      // Leave args empty; the registry will report the missing argument to the LLM.
    }
  } else if (fn.arguments && typeof fn.arguments === 'object') {
    args = fn.arguments
  }
  return {
    ...call,
    function: {
      ...fn,
      arguments: args
    }
  }
}

/**
 * The API requires tool_call.function.arguments to be a JSON string when
 * sending messages back. Our normalized in-memory form is an object, so
 * re-serialize on the way out.
 */
function serializeOutgoingMessages(messages: Message[]): any[] {
  return messages.map((m: any) => {
    if (m.role !== 'assistant' || !m.tool_calls) return m
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc: any) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {})
        }
      }))
    }
  })
}

export class LlmClient {
  private controller: AbortController | null = null

  constructor(private readonly config: Config['llm']) {}

  async chat(messages: Message[], tools: Tool[]): Promise<Message> {
    this.controller = new AbortController()
    const res = await fetch(`${this.config.host}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey || 'sk-a-strong-key'}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: serializeOutgoingMessages(messages),
        tools,
        tool_choice: 'auto',
        stream: false
      }),
      signal: this.controller.signal
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM request failed: ${res.status} ${text}`)
    }

    const data = await res.json()
    const msg = data.choices?.[0]?.message ?? {}
    return {
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls.map(normalizeToolCall) } : {})
    }
  }

  abort() {
    this.controller?.abort()
    this.controller = null
  }
}