import { ToolRegistry } from '../tools/registry.js'
import { LlmClient, Message } from './llm.js'
import { describeWorldState } from '../bot/status.js'
import { guideCatalog } from './prompt.js'
import { Bot } from 'mineflayer'

export type PlannedTask = {
  id: number
  description: string
  done_when: string
  guide_sections: string[]
  needs: string[]
}

export type Plan = {
  goal: string
  needs: string[]
  tasks: PlannedTask[]
}

const PLANNER_SYSTEM = `You are a task planner for a Minecraft bot. Given a player request, the current world state, the available tools, and the available guide sections, produce an ordered task list.

Rules:
- Do NOT call tools other than submit_plan.
- Each task must be concrete, actionable and independently checkable.
- done_when must be verifiable from a tool result (e.g. "check_inventory shows cherry_planks >= 90", "find_block_cells cherry_planks returns >= 70 cells in 301..305,-60..-57,116..120").
- Keep tasks small (one goal each). Split building into: locate site, gather materials, build shell, add door, verify.
- guide_sections must be chosen from the available list.
- needs lists item ids with approximate counts.
- If the request is ambiguous, still produce a plan but add a task "ask the player to clarify X" at the end.
- Call submit_plan exactly once.`

export async function planTask(
  bot: Bot,
  llm: LlmClient,
  registry: ToolRegistry,
  request: { username: string; message: string }
): Promise<Plan> {
  const submitPlanTool = {
    type: 'function' as const,
    function: {
      name: 'submit_plan',
      description: 'Submit the final task plan.',
      parameters: {
        type: 'object',
        required: ['goal', 'needs', 'tasks'],
        properties: {
          goal: { type: 'string', description: 'One-sentence goal' },
          needs: { type: 'array', items: { type: 'string' }, description: 'Item needs across the whole plan' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'description', 'done_when', 'guide_sections', 'needs'],
              properties: {
                id: { type: 'integer' },
                description: { type: 'string' },
                done_when: { type: 'string' },
                guide_sections: { type: 'array', items: { type: 'string' } },
                needs: { type: 'array', items: { type: 'string' } }
              }
            }
          }
        }
      }
    }
  }

  const messages: Message[] = [
    { role: 'system', content: PLANNER_SYSTEM + '\n\n' + guideCatalog() },
    {
      role: 'user',
      content: `Current state:\n${describeWorldState(bot)}\n\n${request.username} says: ${request.message}\n\nAvailable tools:\n${registry.catalog()}`
    }
  ]

  const response = await llm.chat(messages, [submitPlanTool as any])
  const call = (response.tool_calls ?? []).find(c => c.function.name === 'submit_plan')
  if (!call) throw new Error('Planner did not call submit_plan')
  const args = call.function.arguments as any
  if (!args || !Array.isArray(args.tasks)) throw new Error('Planner returned malformed plan')
  return args as Plan
}