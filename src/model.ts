import * as Y from 'yjs'
import { COLWORK_SCHEMA_VERSION, COLWORK_MAP_NAMES, parseCellKey, parseMergeKey, type CellLock, type CellStyle, type SheetSnapshot, type SheetValidationLimits } from './model-schema'
import { getSheetMaps, validateSheetDocument } from './model-validation'
import { bytesToBase64, type YjsSnapshotFile } from './yjsArchive'
export * from './model-schema'
export type { CellPosition, CellRange } from './range'
export { getSheetMaps, validateSheetDocument } from './model-validation'
export { rebuildYjsSnapshot } from './yjsRebuild'
export type { YjsArchiveFile, YjsSnapshotFile, YjsUpdateLogFile, YjsUpdateRecord } from './yjsArchive'

function compareKeys(left: string, right: string) {
  const a = left.split(':').map(Number)
  const b = right.split(':').map(Number)
  return a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0)
}
function orderedEntries<T>(map: Y.Map<T>) { return [...map].sort(([a], [b]) => compareKeys(a, b)) }
function canonicalStyle(style: CellStyle): CellStyle {
  const result: Record<string, unknown> = {}
  for (const key of ['bold', 'italic', 'underline', 'strike', 'wrap', 'fontSize', 'color', 'background', 'align', 'format'] as const) {
    if (style[key] !== undefined) result[key] = style[key]
  }
  if (style.border !== undefined) {
    const border: Record<string, boolean> = {}
    for (const side of ['top', 'right', 'bottom', 'left'] as const) if (style.border[side] !== undefined) border[side] = style.border[side]!
    result.border = border
  }
  return result as CellStyle
}

/** Reads a deterministic sparse sheet without loading a renderer, browser globals, or CSS. */
export function readSheetSnapshot(document: Y.Doc, limits?: SheetValidationLimits): SheetSnapshot {
  const issues = validateSheetDocument(document, limits)
  if (issues.length) throw new TypeError(`Invalid Colwork document at ${issues[0].path}: ${issues[0].message}`)
  const maps = getSheetMaps(document)
  const styles = Object.fromEntries(orderedEntries(maps.styles).map(([key, value]) => [key, canonicalStyle(JSON.parse(value))]))
  const locks: Record<string, CellLock> = Object.fromEntries(orderedEntries(maps.locks).map(([key, value]) => {
    if (value === '1') return [key, '1']
    const lock = JSON.parse(value)
    return [key, { version: lock.version, algorithm: lock.algorithm, iterations: lock.iterations, salt: lock.salt, verifier: lock.verifier }]
  }))
  const merges = [...maps.merges.keys()].map(key => parseMergeKey(key)!).sort((a, b) => a.start.row - b.start.row || a.start.column - b.start.column || a.end.row - b.end.row || a.end.column - b.end.column)
  let rowCount = 1
  let columnCount = 1
  for (const key of [...maps.cells.keys(), ...maps.styles.keys(), ...maps.locks.keys()]) {
    const position = parseCellKey(key)!
    rowCount = Math.max(rowCount, position.row + 1)
    columnCount = Math.max(columnCount, position.column + 1)
  }
  for (const merge of merges) {
    rowCount = Math.max(rowCount, merge.end.row + 1)
    columnCount = Math.max(columnCount, merge.end.column + 1)
  }
  for (const key of maps.rowHeights.keys()) rowCount = Math.max(rowCount, Number(key) + 1)
  for (const key of maps.columnWidths.keys()) columnCount = Math.max(columnCount, Number(key) + 1)
  return { schemaVersion: COLWORK_SCHEMA_VERSION, rowCount, columnCount, cells: Object.fromEntries(orderedEntries(maps.cells)), styles,
    rowHeights: Object.fromEntries(orderedEntries(maps.rowHeights)), columnWidths: Object.fromEntries(orderedEntries(maps.columnWidths)), merges, locks }
}

/** Initializes an empty document without demo cells, headers, styles, or network access. */
export function initializeBlankSheet(document: Y.Doc): void {
  const issues = validateSheetDocument(document)
  if (issues.length) throw new TypeError(`Invalid Colwork document at ${issues[0].path}: ${issues[0].message}`)
  if (Object.values(getSheetMaps(document)).some(map => map.size > 0)) throw new Error('Blank initialization requires an empty sheet')
  const metadata = document.getMap(COLWORK_MAP_NAMES.metadata)
  document.transact(() => {
    metadata.set('schemaVersion', COLWORK_SCHEMA_VERSION)
    metadata.set('initialized', true)
  })
}

export function exportYjsSnapshot(document: Y.Doc, options: { room?: string; sequence?: number } = {}): YjsSnapshotFile {
  const sequence = options.sequence ?? 0
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative safe integer')
  return { format: 'colwork.snapshot', version: 1, room: options.room, sequence,
    snapshot: bytesToBase64(Y.encodeStateAsUpdate(document)), stateVector: bytesToBase64(Y.encodeStateVector(document)) }
}

/** Decodes a Yjs state update and releases its temporary document after export. */
export function readSheetSnapshotUpdate(update: Uint8Array, limits?: SheetValidationLimits): SheetSnapshot {
  const document = new Y.Doc()
  try { Y.applyUpdate(document, update); return readSheetSnapshot(document, limits) }
  finally { document.destroy() }
}
