import { Bot } from 'mineflayer'
import { Config } from '../config.js'
import { createLogger } from '../util/logger.js'

const log = createLogger('chat')

export type ChatSource = 'minecraft' | 'discord'
export type IncomingMessage = { source: ChatSource; username: string; message: string }

/** Discord bridge messages arrive as plain server messages like "Discord Chris: hello". */
const discordPattern = /^Discord\s+([^:]+):\s*(.*)$/

/** Case-insensitive membership check for in-game usernames. */
function isMinecraftOwner(username: string, owners: string[]): boolean {
  const lower = username.toLowerCase()
  return owners.some(o => o.toLowerCase() === lower)
}

/** Forward messages from authorised owners (in-game or via the Discord bridge) to `onMessage`. */
export function listenForOwnerMessages(bot: Bot, owners: Config['owners'], onMessage: (msg: IncomingMessage) => void) {
  // The first configured Minecraft owner is used as the attribution name for Discord requests.
  const primaryMinecraftOwner = owners.minecraft[0]

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (!isMinecraftOwner(username, owners.minecraft)) {
      log.debug(`Ignoring ${username}: ${message}`)
      return
    }
    onMessage({ source: 'minecraft', username, message: message.trim() })
  })

  if (owners.discord.length === 0) return

  bot.on('messagestr', raw => {
    const match = raw.match(discordPattern)
    if (!match) return
    const [, username, message] = match
    const discordName = username.trim()
    if (!owners.discord.some(d => d.toLowerCase() === discordName.toLowerCase())) {
      log.debug(`Ignoring Discord ${discordName}: ${message}`)
      return
    }
    // Attribute Discord requests to the primary in-game owner so player-relative commands ("come here") still work.
    onMessage({ source: 'discord', username: primaryMinecraftOwner, message: message.trim() })
  })
}