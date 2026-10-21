import { Bot } from 'mineflayer'
import { LlmClient, Message } from './llm.js'
import { describeWorldState } from '../bot/status.js'
import { PlannedTask } from './planner.js'

export type Verdict = {
  status: 'done' | 'partial' | 'failed' | 'needs_revision'
  reason: string
  revised_task?: {
    description?: string
    done_when?: string
    needs?: string[]
    guide_sections?: string[]
  }
}

const VERIFIER_SYSTEM = `You are a task verifier for a Minecraft bot. You receive:
- the player's original intent (the overall request),
- the planned task and its done_when condition,
- the tool calls the bot made for this task,
- the current world state (bot position, Terrain, inventory, nearby entities).

Decide whether the task is complete, and if not, whether the task itself should be corrected.

Rules:
- Do NOT call tools other than submit_verdict.
- Judge by done_when, not by how confident the bot sounds. "The bot said it worked" is not evidence; check_inventory / get_status / find_block_cells / inspect_block outputs are.
- A failed tool call does not automatically fail the task. If done_when is satisfied (e.g. give_item succeeded, inventory now shows 0), the task is done even if an earlier tool call errored.
- Keep the player's original intent in mind: a task that satisfies done_when but contradicts the intent (wrong player, wrong item, wrong place) is failed, not done.

Status meanings:
- "done": done_when is satisfied and consistent with the intent. Cite the evidence.
- "partial": some progress, done_when not yet satisfied, but the task is still achievable as written. Say exactly what is missing.
- "failed": the task cannot be completed as written (unreachable target, missing material that cannot be obtained, wrong tool tier).
- "needs_revision": the task's coordinates, item counts or assumptions no longer match the current world, but the goal is still achievable. Provide a revised_task that fixes the mismatch.

When status is needs_revision, you MUST fill revised_task with concrete corrections:
- Fix coordinates: read the bot position / Terrain / find_block_cells output, and put the real absolute coordinates into the new description.
- Fix item counts: if the task needs 25 cherry_slab but check_inventory shows 8, update needs and mention the /give step in the description.
- Fix assumptions: if the task says "wall at y=-57" but the tool output shows y=-58, correct it.
- Do NOT revise for style or wording. Only revise when the current task is factually impossible as written.

Call submit_verdict exactly once.`

function summarizeToolLog(log: string[], max = 30): string {
  if (log.length === 0) return '(no tool calls)'
  const tail = log.slice(-max)
  const prefix = log.length > max ? `(showing last ${max} of ${log.length})\n` : ''
  return prefix + tail.join('\n')
}

export async function verifyTask(
  bot: Bot,
  llm: LlmClient,
  task: PlannedTask,
  originalRequest: { username: string; message: string },
  toolLog: string[]
): Promise<Verdict> {
  const submitVerdictTool = {
    type: 'function' as const,
    function: {
      name: 'submit_verdict',
      description: 'Submit the verification verdict.',
      parameters: {
        type: 'object',
        required: ['status', 'reason'],
        properties: {
          status: { type: 'string', enum: ['done', 'partial', 'failed', 'needs_revision'] },
          reason: { type: 'string' },
          revised_task: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Corrected task description with concrete coordinates/items' },
              done_when: { type: 'string', description: 'Corrected done_when condition' },
              needs: { type: 'array', items: { type: 'string' }, description: 'Corrected item needs' },
              guide_sections: { type: 'array', items: { type: 'string' }, description: 'Corrected guide sections' }
            }
          }
        }
      }
    }
  }

  const messages: Message[] = [
    { role: 'system', content: VERIFIER_SYSTEM },
    {
      role: 'user',
      content:
        `Player intent: ${originalRequest.username} said: "${originalRequest.message}"\n\n` +
        `Current task: ${task.description}\n` +
        `Done when: ${task.done_when}\n` +
        `Items needed: ${task.needs.join(', ') || 'none'}\n\n` +
        `Tool calls made for this task:\n${summarizeToolLog(toolLog)}\n\n` +
        `Current state:\n${describeWorldState(bot)}`
    }
  ]

  const response = await llm.chat(messages, [submitVerdictTool as any])
  const call = (response.tool_calls ?? []).find(c => c.function.name === 'submit_verdict')
  if (!call) return { status: 'failed', reason: 'Verifier did not call submit_verdict' }
  const args = call.function.arguments as any
  if (!args || !args.status || !args.reason) {
    return { status: 'failed', reason: 'Verifier returned malformed verdict' }
  }
  return args as Verdict
}