export type IdentifierSegment = { text: string; full?: string; color?: string; kind?: 'uuid' | 'hex' | 'hex-more'; size?: number }

const identifierPattern = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

function colorFor(value: string) {
  const hex = value.replace(/[^a-f0-9]/gi, '').slice(0, 6).padEnd(6, '0')
  if (hex.length === 6) return `#${hex}`
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `#${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)}`
}

export function splitIdentifiers(text: string): IdentifierSegment[] {
  const segments: IdentifierSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(identifierPattern)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ text: text.slice(cursor, index) })
    const full = match[0]
    segments.push({ text: full.slice(0, 6), full, color: colorFor(full), kind: 'uuid' })
    cursor = index + full.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments.length ? segments : [{ text }]
}

export function splitLogText(text: string): IdentifierSegment[] {
  const hexMatch = /(?:^|\s)(hex=)([0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2})*)\s*$/.exec(text)
  if (!hexMatch || hexMatch.index === undefined) return splitIdentifiers(text)
  const prefix = text.slice(0, hexMatch.index + (hexMatch[0].startsWith(' ') ? 1 : 0)) + hexMatch[1]
  const compact = hexMatch[2].replace(/\s/g, '')
  const chunks = splitHexGroups(compact)
  if (chunks.length > 8) return [...splitIdentifiers(prefix), ...chunks.slice(0, 4), { text: `Size (${compact.length / 2}B)`, full: compact, kind: 'hex-more', color: '#64748b', size: compact.length / 2 }]
  return [...splitIdentifiers(prefix), ...chunks]
}

export function splitHexGroups(compact: string): IdentifierSegment[] {
  const chunks: IdentifierSegment[] = []
  for (let index = 0; index < compact.length; index += 6) {
    const chunk = compact.slice(index, index + 6)
    chunks.push({ text: chunk, color: `#${chunk.padEnd(6, '0')}`, kind: 'hex' })
  }
  return chunks
}
