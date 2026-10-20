import { defineTool } from './types.js'
import { ToolInputError } from './args.js'

const category = 'Admin'

export const commandTools = [
  defineTool({
    name: 'run_command',
    category,
    description:
    'Execute a raw Minecraft command as the bot (requires operator permission). ' +
    'Use this whenever the player asks to "use a command" / "用指令" / "作弊" / "传送" / "填充" / "夜视" / "give me X directly". ' +
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
      bot.chat(command)
      return `Sent command: ${command}`
    }
  })
]