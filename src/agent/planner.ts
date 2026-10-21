import { ToolRegistry } from '../tools/registry.js'
import { LlmClient, Message } from './llm.js'
import { describeWorldState } from '../bot/status.js'
import { guideCatalog } from './prompt.js'
import { Bot } from 'mineflayer'

export type PlannedStep = {
  id: number
  depends_on: number[]
  /** Ids of earlier steps whose output this step needs to read (e.g. a blueprint). */
  consumes: number[]
  description: string
  done_when: string
  /** Optional: what the step's final reply should contain, so later steps can rely on it. */
  output_format?: string
  guide_sections: string[]
  needs: string[]
}

export type Plan = {
  goal: string
  needs: string[]
  tasks: PlannedStep[]
}

const PLANNER_SYSTEM = `You are a task planner for a Minecraft bot. Given a player request, the current world state, the available tools, and the available guide sections, produce an ordered task graph.

Goal: a task list that is COARSE enough to be efficient and SPECIFIC enough to be verifiable. Aim for 2-5 tasks for a normal request.

Rules:
- Do NOT call tools other than submit_plan.
- Each task must be a real world-changing action, or a verification of one. Never plan a "say X" task — announcements and reports are handled separately.
- Merge steps that share a target and need no fresh look at the world between them. Keep separate steps that need a fresh look.
- Prefer letting tools choose details (e.g. place_block picks the exact cell). Do not add a task just to inspect where to act.
- depends_on lists the ids of tasks that MUST finish first. Use [] when there are no prerequisites.
- done_when must be verifiable from a tool result.
- needs lists item ids with approximate counts.
- Call submit_plan exactly once.

Data passing between steps:
- "consumes" lists the ids of earlier steps whose output this step needs. Use it when a step produces a design, a list of coordinates, or any other information that later steps must follow.
- "output_format" describes what the step's final reply must contain, so consumers can rely on it (e.g. "a list of absolute coordinates as (x, y, z) tuples, one per block, plus the material id").
- Steps with no consumers can leave output_format empty.

Complex or abstract tasks:
- If a step is complex or under-specified, split it into smaller concrete steps.
- If a step requires design decisions (a build layout, a route, a list of targets) that later steps must follow, add a dedicated design step first. That step must produce a detailed, unambiguous blueprint as its output (coordinates, sizes, materials, ordering). Later steps consume it with "consumes".
- The blueprint must be specific enough that later steps can execute it directly without re-deciding.`

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
          goal: { type: 'string' },
          needs: { type: 'array', items: { type: 'string' } },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'depends_on', 'consumes', 'description', 'done_when', 'guide_sections', 'needs'],
              properties: {
                id: { type: 'integer' },
                depends_on: { type: 'array', items: { type: 'integer' } },
                consumes: { type: 'array', items: { type: 'integer' } },
                description: { type: 'string' },
                done_when: { type: 'string' },
                output_format: { type: 'string' },
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
  // Normalise so callers can rely on the fields existing.
  for (const t of args.tasks) {
    t.consumes = Array.isArray(t.consumes) ? t.consumes : []
    t.depends_on = Array.isArray(t.depends_on) ? t.depends_on : []
  }
  return args as Plan
}