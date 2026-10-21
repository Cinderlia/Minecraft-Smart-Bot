import mineflayer, { Bot } from 'mineflayer'
import { Config } from '../config.js'
import { createLogger } from '../util/logger.js'
import { applyProtocolFixes } from './protocolFixes.js'
import { installDiagnostics } from './diagnostics.js'
import { serverboundTableFix } from './packetTablePatch.js'

const log = createLogger('bot')

export function createBot(config: Config): Bot {
  const { minecraft } = config

  const bot = mineflayer.createBot({
    host: minecraft.host,
    port: minecraft.port,
    username: minecraft.account,
    auth: minecraft.auth,
    version: minecraft.version,
    profilesFolder: minecraft.profilesFolder,
    customPackets: serverboundTableFix(minecraft.version)
  })

  // The pathfinder plugin is loaded in index.ts, before spawn, and configured
  // in index.ts once chunks are loaded. createBot only wires up protocol and
  // diagnostics here.

  // 26.3 servers require client_tick_end after every position packet
  const origWrite = bot._client.write.bind(bot._client)
  ;(bot._client as any).write = (name: string, packet: any) => {
    const result = origWrite(name, packet)
    if (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') {
      try { origWrite('tick_end', {}) } catch {}
    }
    return result
  }

  installDiagnostics(bot, config.diagnostics)

  // Internal plugins are injected once the version is known; patch them after that.
  bot.once('login', () => applyProtocolFixes(bot))

  bot.once('spawn', () => {
    log.info(`Connected as ${bot.username}`)
  })

  bot.on('death', () => log.warn('Bot died'))
  bot.on('messagestr', (message, position) => {
    if (position !== 'chat') log.debug(`[server] ${message}`)
  })
  bot.on('end', reason => log.info(`Disconnected: ${reason}`))

  return bot
}