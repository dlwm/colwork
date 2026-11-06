import type * as Y from 'yjs'
import type { CellRange } from './range'

/** The existing version-one wire format. Missing metadata is valid legacy data. */
export const COLWORK_SCHEMA_VERSION = 1 as const
export const COLWORK_MAP_NAMES = Object.freeze({
  cells: 'cells', styles: 'styles', rowHeights: 'rowHeights',
  columnWidths: 'columnWidths', merges: 'merges', locks: 'locks',
  metadata: 'colwork-metadata',
} as const)

export type CellBorder = { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }
export type CellStyle = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  wrap?: boolean
  border?: CellBorder
  fontSize?: number
  color?: string
  background?: string
  align?: 'left' | 'center' | 'right'
  format?: 'general' | 'number' | 'date' | 'percent'
}
export type PasswordLock = {
  version: 1
  algorithm: 'PBKDF2-SHA-256'
  iterations: 600000
  salt: string
  verifier: string
}
export type CellLock = '1' | PasswordLock
export type SheetMaps = {
  cells: Y.Map<string>
  styles: Y.Map<string>
  rowHeights: Y.Map<number>
  columnWidths: Y.Map<number>
  merges: Y.Map<string>
  locks: Y.Map<string>
}
/** Sparse, JSON-serializable logical sheet. Dimensions are derived from stored data. */
export type SheetSnapshot = {
  schemaVersion: typeof COLWORK_SCHEMA_VERSION
  rowCount: number
  columnCount: number
  cells: Record<string, string>
  styles: Record<string, CellStyle>
  rowHeights: Record<string, number>
  columnWidths: Record<string, number>
  merges: CellRange[]
  locks: Record<string, CellLock>
}
export type SheetValidationIssue = { path: string; message: string }

export function parseCellKey(key: string) {
  if (!/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(key)) return undefined
  const [row, column] = key.split(':').map(Number)
  return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { row, column } : undefined
}

export function mergeKey(range: CellRange) {
  return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`
}

export function parseMergeKey(key: string): CellRange | undefined {
  const parts = key.split('-')
  if (parts.length !== 2) return undefined
  const start = parseCellKey(parts[0])
  const end = parseCellKey(parts[1])
  if (!start || !end || start.row > end.row || start.column > end.column) return undefined
  return { start, end }
}

/** Optional host policy. Omitted numeric limits impose no application-specific cap. */
export type SheetValidationLimits = {
  maxRows?: number
  maxColumns?: number
  maxEntries?: number
  maxStringLength?: number
  maxMergeArea?: number
  maxMerges?: number
  allowUnknownRoots?: boolean
}
