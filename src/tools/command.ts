import { defineTool } from './types.js'
import { ToolInputError } from './args.js'
import { sleep } from '../util/async.js'

const category = 'Admin'

/** Commands the bot must never run, even if the LLM asks. */
const BLOCKED = ['/kill', '/ban', '/op', '/deop', '/stop', '/clear', '/kick']

/** Lines from the server that carry actual command results or errors. */
const RELEVANT = /has the following|Enchantment|Unknown|error|Successfully|applied|not found|No entity|Cannot|Invalid|That player|does not exist|Usage:/i

export const commandTools = [
  defineTool({
    name: 'run_command',
    category,
    description:
      'Execute a raw Minecraft command as the bot (requires operator permission). ' +
      'Use this whenever the player asks to "use a command" / "用指令" / "作弊" / "传送" / "填充" / "夜视" / "give me X directly". ' +
      'Returns the server response when the command produces one (e.g. /data get, /enchant errors, /give success). ' +
      'Examples:\n' +
      '- /give <player> <item> [count]  →  /give somebody totem_of_undying 1   (works for ANY item id)\n' +
      '- /give <player> <item> [count]  →  /give somebody diamond 64\n' +
      '- /fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [mode]  →  /fill 10 64 10 20 70 20 stone hollow\n' +
      '- /tp <target>  →  /tp somebody\n' +
      '- /tp <target> <x> <y> <z>  →  /tp somebody 100 65 200\n' +
      '- /tp <target> <destination-target>  →  /tp somebody sbot\n' +
      '- /effect give <target> <effect> [seconds] [amplifier]  →  /effect give somebody speed 30 1\n' +
      '- /effect clear <target> [effect]  →  /effect clear somebody\n' +
      '- /enchant <target> <enchantment> [level]  →  /enchant somebody sharpness 5\n' +
      'If the player says "用指令" or "with a command", prefer this over survival tools.',
    params: {
      command: {
        type: 'string',
        description: 'The full command, with or without a leading slash',
        required: true
      }
    },
    async handler(args, { bot }) {
      const raw = args.string('command').trim()
      const command = raw.startsWith('/') ? raw : `/${raw}`
      if (command.length <= 1) throw new ToolInputError('Command is empty')
      if (BLOCKED.some(d => command.startsWith(d))) {
        throw new ToolInputError(`Refusing dangerous command: ${command}`)
      }

      // Capture the server's reply so callers can verify effects (data get, enchant errors, etc.).
      const responses: string[] = []
      const listener = (msg: unknown) => {
        const text = String(msg).trim()
        if (text) responses.push(text)
      }
      bot.on('message', listener)
      try {
        bot.chat(command)
        await sleep(600)
      } finally {
        bot.off('message', listener)
      }

      const relevant = responses.filter(r => RELEVANT.test(r))
      const feedback = relevant.length > 0
        ? ` Server: ${relevant.join(' | ').slice(0, 400)}`
        : ''
      return `Sent command: ${command}.${feedback}`
    }
  })
]