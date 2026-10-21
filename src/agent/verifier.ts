import { Bot } from 'mineflayer'
import { ToolRegistry } from '../tools/registry.js'
import { LlmClient, Message } from './llm.js'
import { describeWorldState } from '../bot/status.js'
import { PlannedTask } from './planner.js'

export type Verdict = {
  status: 'done' | 'partial' | 'failed' | 'needs_revision'
  reason: string
  revised_task?: { description: string; done_when: string }
}

const VERIFIER_SYSTEM = `You are a task verifier for a Minecraft bot. Given a planned task, its done_when condition, the tool calls the bot made, and the current world state, decide whether the task is complete.

Rules:
- Do NOT call tools other than submit_verdict.
- status "done": the done_when condition is satisfied, based on the tool outputs and current state. Cite the evidence.
- status "partial": some progress was made but done_when is not fully satisfied. Say what is missing.
- status "failed": the task could not be completed (wrong coordinates, missing item, unreachable target). Say what blocked it.
- status "needs_revision": the task as written cannot be satisfied with the current world/tools, but a revised version could. Provide revised_task with a new description and done_when that is achievable. Use this sparingly — only when the original task is genuinely impossible, not just unfinished.
- Be strict: "the bot said it worked" is not evidence. Use check_inventory, get_status, find_block_cells, inspect_block outputs as evidence.
- Call submit_verdict exactly once.`

function summarizeToolCalls(log: string[]): string {
  if (log.length === 0) return '(no tool calls)'
  return log.slice(-30).join('\n')  // last 30 tool calls, to stay under context
}

export async function verifyTask(
  bot: Bot,
  llm: LlmClient,
  registry: ToolRegistry,
  task: PlannedTask,
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
              description: { type: 'string' },
              done_when: { type: 'string' }
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
        `Task: ${task.description}\n` +
        `Done when: ${task.done_when}\n` +
        `Items needed: ${task.needs.join(', ') || 'none'}\n\n` +
        `Tool calls made:\n${summarizeToolCalls(toolLog)}\n\n` +
        `Current state:\n${describeWorldState(bot)}`
    }
  ]

  const response = await llm.chat(messages, [submitVerdictTool as any])
  const call = (response.tool_calls ?? []).find(c => c.function.name === 'submit_verdict')
  if (!call) {
    return { status: 'failed', reason: 'Verifier did not call submit_verdict' }
  }
  const args = call.function.arguments as any
  if (!args || !args.status || !args.reason) {
    return { status: 'failed', reason: 'Verifier returned malformed verdict' }
  }
  return args as Verdict
}