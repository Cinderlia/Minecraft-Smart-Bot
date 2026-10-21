const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof levels

const threshold = levels[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? levels.info

function write(level: Level, scope: string, message: string, extra: unknown[]) {
  if (levels[level] < threshold) return
  const time = new Date().toISOString().slice(11, 19)
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  // stderr is line-buffered even when piped, so entries appear immediately.
  process.stderr.write(line + (extra.length > 0 ? ' ' + extra.map(formatExtra).join(' ') : '') + '\n')
}

function formatExtra(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

export type Logger = ReturnType<typeof createLogger>

export function createLogger(scope: string) {
  return {
    debug: (message: string, ...extra: unknown[]) => write('debug', scope, message, extra),
    info: (message: string, ...extra: unknown[]) => write('info', scope, message, extra),
    warn: (message: string, ...extra: unknown[]) => write('warn', scope, message, extra),
    error: (message: string, ...extra: unknown[]) => write('error', scope, message, extra)
  }
}