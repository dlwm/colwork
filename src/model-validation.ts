import * as Y from 'yjs'
import { isUnicodeString } from './unicode'
import { COLWORK_MAP_NAMES, COLWORK_SCHEMA_VERSION, parseCellKey, parseMergeKey, type CellStyle, type PasswordLock, type SheetMaps, type SheetValidationIssue, type SheetValidationLimits } from './model-schema'
import { hasOverlappingMerges } from './model-merges'
import type { CellRange } from './range'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const knownKeys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key))

export function isPasswordLock(value: unknown): value is PasswordLock {
  return isRecord(value) && knownKeys(value, ['version', 'algorithm', 'iterations', 'salt', 'verifier'])
    && value.version === 1 && value.algorithm === 'PBKDF2-SHA-256' && value.iterations === 600000
    && typeof value.salt === 'string' && /^[0-9a-f]{32}$/.test(value.salt)
    && typeof value.verifier === 'string' && /^[0-9a-f]{64}$/.test(value.verifier)
}

export function isCellStyle(value: unknown): value is CellStyle {
  if (!isRecord(value) || !knownKeys(value, ['bold', 'italic', 'underline', 'strike', 'wrap', 'border', 'fontSize', 'color', 'background', 'align', 'format'])) return false
  for (const key of ['bold', 'italic', 'underline', 'strike', 'wrap']) if (key in value && typeof value[key] !== 'boolean') return false
  for (const key of ['color', 'background']) if (key in value && (typeof value[key] !== 'string' || !isUnicodeString(value[key] as string))) return false
  if ('fontSize' in value && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize <= 0)) return false
  if ('align' in value && (typeof value.align !== 'string' || !['left', 'center', 'right'].includes(value.align))) return false
  if ('format' in value && (typeof value.format !== 'string' || !['general', 'number', 'date', 'percent'].includes(value.format))) return false
  if ('border' in value) {
    if (!isRecord(value.border) || !knownKeys(value.border, ['top', 'right', 'bottom', 'left'])) return false
    for (const key of Object.keys(value.border)) if (typeof value.border[key] !== 'boolean') return false
  }
  return true
}

/** Materializes named Y.Map roots, preserving the version-one encoding. */
export function getSheetMaps(document: Y.Doc): SheetMaps {
  return {
    cells: document.getMap(COLWORK_MAP_NAMES.cells), styles: document.getMap(COLWORK_MAP_NAMES.styles),
    rowHeights: document.getMap(COLWORK_MAP_NAMES.rowHeights), columnWidths: document.getMap(COLWORK_MAP_NAMES.columnWidths),
    merges: document.getMap(COLWORK_MAP_NAMES.merges), locks: document.getMap(COLWORK_MAP_NAMES.locks),
  }
}

export function validateSheetDocument(document: Y.Doc, limits: SheetValidationLimits = {}): SheetValidationIssue[] {
  for (const key of ['maxRows', 'maxColumns', 'maxEntries', 'maxStringLength', 'maxMergeArea', 'maxMerges'] as const) {
    const value = limits[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`${key} must be a non-negative safe integer`)
  }
  const issues: SheetValidationIssue[] = []
  if (document.store.pendingStructs !== null || document.store.pendingDs !== null) {
    issues.push({ path: '$', message: 'Document contains unresolved Yjs update dependencies' })
  }
  const issue = (path: string, message: string) => { issues.push({ path, message }) }
  if (!limits.allowUnknownRoots) {
    for (const key of document.share.keys()) {
      if (!(Object.values(COLWORK_MAP_NAMES) as string[]).includes(key)) issue(key, 'Unknown document root')
    }
  }
  let maps: SheetMaps
  let metadata: Y.Map<unknown>
  try { maps = getSheetMaps(document); metadata = document.getMap(COLWORK_MAP_NAMES.metadata) } catch {
    return [...issues, { path: '$', message: 'Sheet roots must be Y.Map values' }]
  }
  // Yjs can apply sequence content to a pre-materialized map. Map iteration alone
  // cannot detect these incompatible text/array/XML updates, including embeds.
  for (const [name, map] of [...Object.entries(maps), ['metadata', metadata]] as Array<[string, Y.Map<unknown>]>) {
    if (!(map instanceof Y.Map) || map._start !== null) issue(name, 'Expected map entries without sequence content')
  }
  const count = Object.values(maps).reduce((total, map) => total + map.size, metadata.size)
  if (limits.maxEntries !== undefined && count > limits.maxEntries) issue('$', 'Document exceeds maxEntries')
  const positionValid = (row: number, column: number) => row < Number.MAX_SAFE_INTEGER && column < Number.MAX_SAFE_INTEGER
    && (limits.maxRows === undefined || row < limits.maxRows) && (limits.maxColumns === undefined || column < limits.maxColumns)
  const jsonValid = (value: unknown, check: (parsed: unknown) => boolean) => {
    if (typeof value !== 'string') return false
    try { return check(JSON.parse(value)) } catch { return false }
  }
  const stringValid = (name: string, key: string, value: unknown) => {
    if (typeof value === 'string' && limits.maxStringLength !== undefined && value.length > limits.maxStringLength) issue(`${name}.${key}`, 'String exceeds maxStringLength')
  }
  for (const name of ['cells', 'styles', 'locks'] as const) {
    maps[name].forEach((value, key) => {
      const position = parseCellKey(key)
      if (!position || !positionValid(position.row, position.column)) issue(`${name}.${key}`, 'Invalid or out-of-bounds row:column key')
      stringValid(name, key, value)
      if (name === 'cells' && (typeof value !== 'string' || !isUnicodeString(value))) issue(`${name}.${key}`, 'Cell values must be strings')
      if (name === 'styles' && !jsonValid(value, isCellStyle)) issue(`${name}.${key}`, 'Expected a JSON CellStyle object')
      if (name === 'locks' && value !== '1' && !jsonValid(value, isPasswordLock)) issue(`${name}.${key}`, 'Expected a plain lock or version-one password verifier')
    })
  }
  for (const name of ['rowHeights', 'columnWidths'] as const) {
    maps[name].forEach((value, key) => {
      const index = Number(key)
      const bound = name === 'rowHeights' ? limits.maxRows : limits.maxColumns
      if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(index) || index >= Number.MAX_SAFE_INTEGER || (bound !== undefined && index >= bound)) issue(`${name}.${key}`, 'Invalid or out-of-bounds index')
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) issue(`${name}.${key}`, 'Sizes must be finite positive numbers')
    })
  }
  if (limits.maxMerges !== undefined && maps.merges.size > limits.maxMerges) issue('merges', 'Document exceeds maxMerges')
  const merges: CellRange[] = []
  maps.merges.forEach((value, key) => {
    const range = parseMergeKey(key)
    if (!range || value !== '1' || !positionValid(range.end.row, range.end.column)) issue(`merges.${key}`, 'Invalid or out-of-bounds merge range')
    else {
      if (limits.maxMergeArea !== undefined && range.end.row - range.start.row + 1 > limits.maxMergeArea / (range.end.column - range.start.column + 1)) {
        issue(`merges.${key}`, 'Merge exceeds maxMergeArea')
      }
      merges.push(range)
    }
  })
  if (hasOverlappingMerges(merges)) issue('merges', 'Merge ranges must not overlap')
  metadata.forEach((value, key) => {
    if (key === 'schemaVersion') {
      if (value !== COLWORK_SCHEMA_VERSION) issue('metadata.schemaVersion', 'Unsupported schema version')
    } else if (key === 'initialized') {
      if (typeof value !== 'boolean') issue('metadata.initialized', 'Expected a boolean')
    } else issue(`metadata.${key}`, 'Unknown metadata field')
  })
  return issues
}
