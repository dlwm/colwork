export type LogType = 'yjs' | 'webrtc' | 'signal' | 'awareness' | 'peer' | 'sync' | 'room'
export type LogEntry = { text: string; type: LogType }
export type FormattedLog = { prefix: string; json?: string; value?: unknown }

export const logTypes: LogType[] = ['yjs', 'webrtc', 'signal', 'awareness', 'peer', 'sync', 'room']
const logFilterStorageKey = 'colwork-log-filters'

export function classifyLog(text: string): LogEntry {
  return { text, type: logTypes.find((type) => text.includes(`${type}:`)) ?? 'sync' }
}

export function loadLogTypes(): Set<LogType> {
  try {
    const saved = JSON.parse(localStorage.getItem(logFilterStorageKey) ?? 'null')
    if (Array.isArray(saved)) return new Set(saved.filter((type): type is LogType => logTypes.includes(type)))
  } catch {
    // Use all filters when localStorage is unavailable or malformed.
  }
  return new Set(logTypes)
}

export function saveLogTypes(types: Set<LogType>) {
  try {
    localStorage.setItem(logFilterStorageKey, JSON.stringify([...types]))
  } catch {
    // Filtering still works for the current page when storage is blocked.
  }
}

export function formatLog(text: string): FormattedLog {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{' && text[index] !== '[') continue
    try {
      const value = JSON.parse(text.slice(index))
      return { prefix: text.slice(0, index).trimEnd(), json: JSON.stringify(value, null, 2), value }
    } catch {
      // A brace in plain text is not necessarily the start of JSON.
    }
  }
  return { prefix: text }
}
