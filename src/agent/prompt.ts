import fs from 'fs'
import path from 'path'
import { ToolRegistry } from '../tools/registry.js'

const guideRaw = fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'guide.md'), 'utf8')

/** Split guide.md into sections keyed by their "## " heading. */
const guideSections = (() => {
  const map = new Map<string, string>()
  const parts = guideRaw.split(/^## /m)
  const preamble = parts.shift() ?? ''
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = nl === -1 ? '' : part.slice(nl + 1).trim()
    map.set(heading, `## ${heading}\n\n${body}`)
  }
  return { preamble, map }
})()

/** All available guide section headings. */
export function listGuideSections(): string[] {
  return [...guideSections.map.keys()]
}

/** Compact heading list for the selection-stage prompt. */
export function guideCatalog(): string {
  const lines = listGuideSections().map(h => `- ${h}`).join('\n')
  return `## Available guide sections\nCall select_guide to load the ones this task needs.\n${lines}`
}

/** Render the given headings as guide text. Empty list => full guide (safe fallback). */
export function renderGuideSections(headings: string[]): string {
  if (headings.length === 0) return guideRaw
  const body = headings
    .map(h => guideSections.map.get(h))
    .filter((x): x is string => Boolean(x))
    .join('\n\n')
  return body || guideRaw
}

export function buildSystemPrompt(
  botName: string,
  registry: ToolRegistry,
  guideText: string
): string {
  return `You are ${botName}, an AI-controlled player in a live Minecraft survival world. Players give you requests in chat and you carry them out by calling tools.

Rules:
- Act through tools. Never claim you did something unless a tool result confirms it.
- Tool results are ground truth. Read errors and adapt instead of repeating the same call.
- Do one tool call at a time, then decide the next step from the result. Don't batch independent calls.
- Before choosing coordinates for any block action, read the Terrain section of Current state. It lists solid blocks as absolute-coordinate boxes and their air holes. Compute target coordinates from that data; do not guess or sweep coordinates one by one.
- Prefer high-level tools (collect_block, craft_item, smelt_item) over manual go_to/dig_block sequences.
- Intent words:
  - "collect / gather / mine / get / farm / harvest" + a block → the player wants to KEEP it: use collect_block.
  - "clear / remove / clean / dig out / break / destroy / empty / open up" → the player wants the block GONE: use dig_block at its coordinates (or fill_region only when replacing with another block in the same area). Do NOT use collect_block for these.
  - "place / build / put / set up" → use place_block (single) or fill_region (many).
- If a tool only did part of the job, continue — try a broader name/radius or explore, up to 2–3 attempts.
- When finished, reply with one short chat message (no tool call); it is posted to chat automatically.
- If a request is ambiguous or impossible, say briefly what's missing or ask.
- Never attack the player you are talking to, and don't destroy player builds unless asked.
- Missing materials: when a task needs items the bot does not have, call run_command with "/give sbot <item> <count>" instead of gathering, crafting or mining. 
  Examples: no cobblestone to build → run_command "/give sbot cobblestone 64". Use the exact item id (e.g. cherry_planks, totem_of_undying). Only fall back to collect_block / craft_item when run_command fails or the player explicitly asked to gather.

Your abilities (tools), by category:
${registry.catalog()}

${guideText}`
}

export function buildUserMessage(username: string, message: string, worldState: string): string {
  return `Current state:
${worldState}

${username} says: ${message}`
}