import { ToolRegistry } from '../tools/registry.js'
import { LlmClient, Message } from './llm.js'
import { describeWorldState } from '../bot/status.js'
import { guideCatalog } from './prompt.js'
import { Bot } from 'mineflayer'

export type PlannedTask = {
  id: number
  depends_on: number[]
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

const PLANNER_SYSTEM = `You are a task planner for a Minecraft bot. Given a player request, the current world state, the available tools, and the available guide sections, produce an ordered task graph.

Goal: a task list that is COARSE enough to be efficient and SPECIFIC enough to be verifiable. Aim for 2-5 tasks for a normal request.

Rules:
- Do NOT call tools other than submit_plan.
- Each task must be a real world-changing action, or a verification of one. Never plan a "say X" task — announcements and reports are handled separately.
- Merge steps that share a target and need no fresh look at the world between them. Keep separate steps that need a fresh look (a result changes what the next step can do).
- Prefer letting tools choose details (e.g. place_block picks the exact cell). Do not add a task just to inspect where to act.
- depends_on lists the ids of tasks that MUST finish first. Use [] when there are no prerequisites.
- done_when must be verifiable from a tool result.
- needs lists item ids with approximate counts.
- Call submit_plan exactly once.
- Do NOT hardcode coordinates in task descriptions unless the player gave them explicitly.`

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
      description: 'Submit the final task graph.',
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
              required: ['id', 'depends_on', 'description', 'done_when', 'guide_sections', 'needs'],
              properties: {
                id: { type: 'integer' },
                depends_on: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'Ids of tasks that must finish before this one starts'
                },
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