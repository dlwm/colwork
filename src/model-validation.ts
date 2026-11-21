import * as Y from 'yjs'
import { isUnicodeString } from './unicode'
import { COLWORK_MAP_NAMES, COLWORK_SCHEMA_VERSION, type CellStyle, type PasswordLock, type SheetMaps, type SheetValidationIssue, type SheetValidationLimits, type WorkbookValidationLimits } from './model-schema'
import { hasOverlappingMerges } from './model-merges'
import type { CellRange } from './range'
import { axisRootNames, parseAxisId, SheetCoordinates, type SheetAxis } from './sheetCoordinates'
import { featureRootNames, getSheetFeatureMaps, isAnalysis, isConditionalFormat, isDataValidation, readFeature } from './sheetFeatures'
import { countVisibleSheets, sheetRoot, sheetIdPattern, normalizeSheetName, MAIN_SHEET_ID, workbookRoot, workbookOrderRoot, workbookLayoutRoot } from './workbookModel'

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
export function getSheetMaps(document: Y.Doc, sheetId?: string): SheetMaps {
  const root = (name: string) => sheetRoot(name, sheetId)
  return {
    cells: document.getMap(root(COLWORK_MAP_NAMES.cells)), styles: document.getMap(root(COLWORK_MAP_NAMES.styles)),
    rowHeights: document.getMap(root(COLWORK_MAP_NAMES.rowHeights)), columnWidths: document.getMap(root(COLWORK_MAP_NAMES.columnWidths)),
    merges: document.getMap(root(COLWORK_MAP_NAMES.merges)), locks: document.getMap(root(COLWORK_MAP_NAMES.locks)),
  }
}

const sheetArrays = new Set<string>(Object.values(axisRootNames))
const sheetMaps = new Set<string>([...Object.values(COLWORK_MAP_NAMES), ...Object.values(featureRootNames)])

/** Classifies both legacy roots and the namespaced roots of registered sheets. */
export function colworkRoot(key: string): { type: 'map' | 'array'; sheetId?: string } | undefined {
  if (key === workbookOrderRoot) return { type: 'array' }
  if (key === workbookRoot || key === workbookLayoutRoot) return { type: 'map' }
  const [prefix, id, field, extra] = key.split(':')
  if (id !== undefined && (prefix !== 'colwork-sheet' || id === MAIN_SHEET_ID || !sheetIdPattern.test(id) || !field || extra !== undefined)) return
  const name = field ?? key
  if (sheetArrays.has(name)) return { type: 'array', sheetId: id ?? MAIN_SHEET_ID }
  if (sheetMaps.has(name)) return { type: 'map', sheetId: id ?? MAIN_SHEET_ID }
}

function validateLimits(limits: WorkbookValidationLimits) {
  for (const key of ['maxRows', 'maxColumns', 'maxEntries', 'maxStringLength', 'maxMergeArea', 'maxMerges', 'maxSheets', 'maxRegisteredSheets'] as const) {
    const value = limits[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`${key} must be a non-negative safe integer`)
  }
}

export function validateSheetDocument(document: Y.Doc, limits: SheetValidationLimits = {}, sheetId?: string): SheetValidationIssue[] {
  validateLimits(limits)
  const issues: SheetValidationIssue[] = []
  if (document.store.pendingStructs !== null || document.store.pendingDs !== null) {
    issues.push({ path: '$', message: 'Document contains unresolved Yjs update dependencies' })
  }
  if (!limits.allowUnknownRoots) {
    for (const key of document.share.keys()) if (!colworkRoot(key)) issues.push({ path: key, message: 'Unknown document root' })
  }
  return issues.concat(validateSheetRoots(document, limits, sheetId))
}

function validateSheetRoots(document: Y.Doc, limits: SheetValidationLimits, sheetId?: string): SheetValidationIssue[] {
  const issues: SheetValidationIssue[] = []
  const issue = (path: string, message: string) => { issues.push({ path, message }) }
  let maps: SheetMaps
  let metadata: Y.Map<unknown>
  let features: ReturnType<typeof getSheetFeatureMaps>
  let coordinates: SheetCoordinates
  try { maps = getSheetMaps(document, sheetId); features = getSheetFeatureMaps(document, sheetId); metadata = document.getMap(sheetRoot(COLWORK_MAP_NAMES.metadata, sheetId)) } catch {
    return [...issues, { path: '$', message: 'Sheet roots must be Y.Map values' }]
  }
  try { coordinates = new SheetCoordinates(document, sheetId) } catch {
    return [...issues, { path: '$', message: 'Axis edits must be Y.Array values' }]
  }
  // Yjs can apply sequence content to a pre-materialized map. Map iteration alone
  // cannot detect these incompatible text/array/XML updates, including embeds.
  for (const [name, map] of [...Object.entries(maps), ...Object.entries(features), ['metadata', metadata]] as Array<[string, Y.Map<unknown>]>) {
    if (!(map instanceof Y.Map) || map._start !== null) issue(name, 'Expected map entries without sequence content')
  }
  for (const axis of ['row', 'column'] as const) {
    const operations = coordinates.edits[axis]
    if (operations._map.size) issue(axisRootNames[axis], 'Expected sequence content without map entries')
    const inserted = new Set<string>()
    operations.forEach((operation, index) => {
      const id = typeof operation === 'string' ? parseAxisId(operation.startsWith('!') ? operation.slice(1) : operation) : undefined
      if (!id || (!operation.startsWith('!') && (!id.inserted || inserted.has(operation)))) {
        issue(`${axisRootNames[axis]}.${index}`, 'Invalid or duplicate axis operation')
      } else if (!operation.startsWith('!')) {
        inserted.add(operation)
      }
    })
    const bound = axis === 'row' ? limits.maxRows : limits.maxColumns
    const extent = coordinates.extent(axis)
    if (!Number.isSafeInteger(extent) || (extent > 1 && bound !== undefined && extent > bound)) issue(axisRootNames[axis], 'Axis exceeds the allowed extent')
  }
  const count = [...Object.values(maps), ...Object.values(features)].reduce((total, map) => total + map.size,
    metadata.size + coordinates.edits.row.length + coordinates.edits.column.length)
  if (limits.maxEntries !== undefined && count > limits.maxEntries) issue('$', 'Document exceeds maxEntries')
  const positionValid = (row: number, column: number) => row < Number.MAX_SAFE_INTEGER && column < Number.MAX_SAFE_INTEGER
    && (limits.maxRows === undefined || row < limits.maxRows) && (limits.maxColumns === undefined || column < limits.maxColumns)
  const axisIdValid = (axis: SheetAxis, id: string) => {
    const parsed = parseAxisId(id)
    return !!parsed && (!parsed.inserted || coordinates.edits[axis]._start !== null)
  }
  const cellIdValid = (id: string) => {
    const [row, column, extra] = id.split(':')
    return row !== undefined && column !== undefined && extra === undefined && axisIdValid('row', row) && axisIdValid('column', column)
  }
  const jsonValid = (value: unknown, check: (parsed: unknown) => boolean) => {
    if (typeof value !== 'string') return false
    try { return check(JSON.parse(value)) } catch { return false }
  }
  const stringValid = (name: string, key: string, value: unknown) => {
    if (typeof value === 'string' && limits.maxStringLength !== undefined && value.length > limits.maxStringLength) issue(`${name}.${key}`, 'String exceeds maxStringLength')
  }
  for (const name of ['cells', 'styles', 'locks'] as const) {
    maps[name].forEach((value, key) => {
      const position = coordinates.cellPosition(key)
      if (!cellIdValid(key) || (position && !positionValid(position.row, position.column))) issue(`${name}.${key}`, 'Invalid or out-of-bounds row:column key')
      stringValid(name, key, value)
      if (name === 'cells' && (typeof value !== 'string' || !isUnicodeString(value))) issue(`${name}.${key}`, 'Cell values must be strings')
      if (name === 'styles' && !jsonValid(value, isCellStyle)) issue(`${name}.${key}`, 'Expected a JSON CellStyle object')
      if (name === 'locks' && value !== '1' && !jsonValid(value, isPasswordLock)) issue(`${name}.${key}`, 'Expected a plain lock or version-one password verifier')
    })
  }
  for (const name of ['rowHeights', 'columnWidths'] as const) {
    maps[name].forEach((value, key) => {
      const axis = name === 'rowHeights' ? 'row' : 'column'
      const index = coordinates.axisPosition(axis, key)
      const bound = axis === 'row' ? limits.maxRows : limits.maxColumns
      if (!axisIdValid(axis, key) || (index !== undefined && (!Number.isSafeInteger(index) || index >= Number.MAX_SAFE_INTEGER || (bound !== undefined && index >= bound)))) issue(`${name}.${key}`, 'Invalid or out-of-bounds index')
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) issue(`${name}.${key}`, 'Sizes must be finite positive numbers')
    })
  }
  if (limits.maxMerges !== undefined && maps.merges.size > limits.maxMerges) issue('merges', 'Document exceeds maxMerges')
  const merges: CellRange[] = []
  maps.merges.forEach((value, key) => {
    const [startId, endId, extra] = key.split('-')
    const start = startId && coordinates.cellPosition(startId)
    const end = endId && coordinates.cellPosition(endId)
    if (!startId || !endId || extra !== undefined || !cellIdValid(startId) || !cellIdValid(endId) || value !== '1'
      || (start && end && (start.row > end.row || start.column > end.column || !positionValid(end.row, end.column)))) {
      issue(`merges.${key}`, 'Invalid or out-of-bounds merge range')
    } else if (start && end) {
      const range = { start, end }
      if (limits.maxMergeArea !== undefined && range.end.row - range.start.row + 1 > limits.maxMergeArea / (range.end.column - range.start.column + 1)) {
        issue(`merges.${key}`, 'Merge exceeds maxMergeArea')
      }
      merges.push(range)
    }
  })
  if (limits.mergeConflicts !== 'resolve' && hasOverlappingMerges(merges)) issue('merges', 'Merge ranges must not overlap')
  const featureRangeValid = (key: string) => {
    const [start, end, extra] = key.split('-')
    const first = start && coordinates.cellPosition(start)
    const last = end && coordinates.cellPosition(end)
    return !!start && !!end && extra === undefined && cellIdValid(start) && cellIdValid(end)
      && (!(first && last) || (first.row <= last.row && first.column <= last.column && positionValid(last.row, last.column)))
  }
  for (const [name, map] of Object.entries(features) as Array<[keyof typeof features, Y.Map<string>]>) {
    map.forEach((value, key) => {
      stringValid(name, key, value)
      if (name === 'analyses') {
        const analysis = readFeature(value, isAnalysis)
        if (!analysis || !/^[a-f0-9]{32}$/.test(key) || !featureRangeValid(analysis.range)
          || [analysis.group, analysis.value, analysis.column].some(id => id !== undefined && !axisIdValid('column', id))) issue(`${name}.${key}`, 'Invalid analysis')
      } else if (!featureRangeValid(key) || !(name === 'validation' ? readFeature(value, isDataValidation) : readFeature(value, isConditionalFormat))) {
        issue(`${name}.${key}`, 'Invalid sheet rule')
      }
    })
  }
  metadata.forEach((value, key) => {
    if (key === 'schemaVersion') {
      if (value !== COLWORK_SCHEMA_VERSION) issue('metadata.schemaVersion', 'Unsupported schema version')
    } else if (key === 'initialized') {
      if (typeof value !== 'boolean') issue('metadata.initialized', 'Expected a boolean')
    } else issue(`metadata.${key}`, 'Unknown metadata field')
  })
  return issues
}


/** Validates all registered sheets, including retained roots of deleted sheets. */
export function validateWorkbook(document: Y.Doc, limits: WorkbookValidationLimits = {}): SheetValidationIssue[] {
  validateLimits(limits)
  const issues: SheetValidationIssue[] = []
  const issue = (path: string, message: string) => { issues.push({ path, message }) }
  if (document.store.pendingStructs !== null || document.store.pendingDs !== null) issue('$', 'Document contains unresolved Yjs update dependencies')
  let entries: Y.Map<unknown>
  let order: Y.Array<unknown>
  let layout: Y.Map<unknown>
  try {
    entries = document.getMap(workbookRoot)
    order = document.getArray(workbookOrderRoot)
    layout = document.getMap(workbookLayoutRoot)
  } catch {
    issue('$', 'Invalid workbook metadata roots')
    return issues
  }
  if (entries._start !== null) issue(workbookRoot, 'Expected map entries without sequence content')
  if (order._map.size) issue(workbookOrderRoot, 'Expected sequence content without map entries')
  if (layout._start !== null) issue(workbookLayoutRoot, 'Expected map entries without sequence content')

  const ids = new Set([MAIN_SHEET_ID])
  for (const [id, name] of entries) {
    if (!sheetIdPattern.test(id)) {
      issue(`${workbookRoot}.${id}`, 'Invalid sheet ID')
      continue
    }
    ids.add(id)
    if (name === null) continue
    try {
      if (typeof name !== 'string' || !isUnicodeString(name)) throw new TypeError()
      normalizeSheetName(name)
    } catch { issue(`${workbookRoot}.${id}`, 'Invalid sheet name') }
  }
  if (limits.maxSheets !== undefined && countVisibleSheets(entries) > limits.maxSheets) issue(workbookRoot, 'Workbook exceeds maxSheets')
  if (limits.maxRegisteredSheets !== undefined && ids.size > limits.maxRegisteredSheets) issue(workbookRoot, 'Workbook exceeds maxRegisteredSheets')
  const validId = (id: unknown): id is string => typeof id === 'string' && ids.has(id)
  // Old peers could concurrently rewrite the array, producing repeated valid IDs.
  order.forEach((id, index) => {
    if (!validId(id)) issue(`${workbookOrderRoot}.${index}`, 'Expected a registered sheet ID')
  })
  let extraOrderEntries = 0
  for (const [key, value] of layout) {
    if (key !== 'order' || !Array.isArray(value)) {
      issue(`${workbookLayoutRoot}.${key}`, 'Expected a sheet order array')
      continue
    }
    extraOrderEntries += value.length
    const seen = new Set<string>()
    for (const [index, id] of value.entries()) {
      if (!validId(id) || seen.has(id)) issue(`${workbookLayoutRoot}.order.${index}`, 'Expected a unique registered sheet ID')
      else seen.add(id)
    }
  }
  let entriesCount = entries.size + order.length + layout.size + extraOrderEntries
  for (const name of [...document.share.keys()]) {
    const root = colworkRoot(name)
    if (!root) {
      if (!limits.allowUnknownRoots) issue(name, 'Unknown document root')
      continue
    }
    if (root.sheetId === undefined) continue
    if (!ids.has(root.sheetId)) issue(name, 'Sheet has no workbook entry')
    try {
      entriesCount += root.type === 'array' ? document.getArray(name).length : document.getMap(name).size
    } catch { issue(name, `Expected a ${root.type} root`) }
  }
  if (limits.maxEntries !== undefined && entriesCount > limits.maxEntries) issue('$', 'Workbook exceeds maxEntries')
  for (const id of ids) {
    const sheetIssues = validateSheetRoots(document, { ...limits, maxEntries: undefined, mergeConflicts: limits.mergeConflicts ?? 'resolve' }, id)
    for (const { path, message } of sheetIssues) issue(`sheets.${id}.${path}`, message)
  }
  return issues
}
