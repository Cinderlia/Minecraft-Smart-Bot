import type { Tool } from 'ollama'
import { setActivity } from '../bot/diagnostics.js'
import { TaskCancelledError, errorMessage } from '../util/async.js'
import { Args, ToolInputError } from './args.js'
import { buildingTools } from './building.js'
import { combatTools } from './combat.js'
import { communicationTools } from './communication.js'
import { containerTools } from './containers.js'
import { craftingTools } from './crafting.js'
import { farmingTools } from './farming.js'
import { gatheringTools } from './gathering.js'
import { interactionTools } from './interaction.js'
import { inventoryTools } from './inventory.js'
import { movementTools } from './movement.js'
import { perceptionTools } from './perception.js'
import { survivalTools } from './survival.js'
import { ToolContext, ToolDefinition } from './types.js'

export type ToolCall = { name: string; arguments: Record<string, unknown> }
export type ToolOutcome = { ok: boolean; output: string }

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  constructor(definitions: ToolDefinition[]) {
    for (const tool of definitions) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
      this.tools.set(tool.name, tool)
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  toOllamaTools(): Tool[] {
    return this.list().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          required: Object.entries(tool.params).filter(([, p]) => p.required).map(([name]) => name),
          properties: Object.fromEntries(Object.entries(tool.params).map(([name, p]) => [
            name,
            { type: p.type, description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}) }
          ]))
        }
      }
    }))
  }

  /** One line per tool, grouped by category; embedded in the system prompt. */
  catalog(): string {
    const byCategory = new Map<string, ToolDefinition[]>()
    for (const tool of this.list()) {
      byCategory.set(tool.category, [...(byCategory.get(tool.category) ?? []), tool])
    }
    return [...byCategory.entries()].map(([category, tools]) =>
      `${category}:\n` + tools.map(t => `- ${t.name}: ${t.description}`).join('\n')
    ).join('\n\n')
  }

  /**
   * Run a tool. Errors become `{ ok: false }` results so the LLM can see what
   * went wrong and adapt; only cancellation propagates.
   */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(call.name)
    if (!tool) return { ok: false, output: `Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(', ')}` }

    setActivity(`${call.name} ${JSON.stringify(call.arguments ?? {})}`)
    try {
      const output = await tool.handler(new Args(call.arguments ?? {}), ctx)
      return { ok: true, output }
    } catch (error) {
      if (error instanceof TaskCancelledError || ctx.signal.aborted) throw new TaskCancelledError()
      if (!(error instanceof ToolInputError)) ctx.log.warn(`Tool ${call.name} failed`, error)
      return { ok: false, output: `Error: ${errorMessage(error)}` }
    } finally {
      setActivity('idle')
    }
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    ...communicationTools,
    ...planningTools,
    ...perceptionTools,
    ...movementTools,
    ...gatheringTools,
    ...farmingTools,
    ...craftingTools,
    ...inventoryTools,
    ...containerTools,
    ...buildingTools,
    ...combatTools,
    ...survivalTools,
    ...interactionTools
  ])
}
