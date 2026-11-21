import type * as Y from 'yjs'

export const MAIN_SHEET_ID = 'main'
export const workbookRoot = 'colwork-workbook'
export const workbookOrderRoot = 'colwork-workbook-order'
export const workbookLayoutRoot = 'colwork-workbook-layout'
export const sheetIdPattern = /^(?:main|[a-f0-9]{32})$/
export type WorkbookSheet = { id: string; name: string }

export function sheetRoot(name: string, id = MAIN_SHEET_ID) {
  if (!sheetIdPattern.test(id)) throw new TypeError('Invalid sheet ID')
  return id === MAIN_SHEET_ID ? name : `colwork-sheet:${id}:${name}`
}

export function makeSheetId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}

export function normalizeSheetName(value: string) {
  const name = value.trim()
  if (!name || name.length > 31 || /[\\/*?:\[\]\u0000-\u001f]/.test(name) || name.startsWith("'") || name.endsWith("'") || name.toLowerCase() === 'history') {
    throw new TypeError('工作表名称需为 1–31 个字符，且不能包含 Excel 保留字符')
  }
  return name
}

export function listWorkbookSheets(doc: Y.Doc): WorkbookSheet[] {
  const entries = doc.getMap<string | null>(workbookRoot)
  const creationOrder = doc.getArray<string>(workbookOrderRoot).toArray()
  const order = new Map(creationOrder.map((id, index) => [id, index]))
  const stored = new Map([...entries].filter(([id, name]) => sheetIdPattern.test(id) && typeof name === 'string'))
  if (!entries.has(MAIN_SHEET_ID)) stored.set(MAIN_SHEET_ID, '工作表1')
  if (!stored.size) return [{ id: MAIN_SHEET_ID, name: '工作表1' }]
  const position = (id: string) => order.get(id) ?? (id === MAIN_SHEET_ID && !entries.has(id) ? -2 : -1)
  const fallback = [...stored.keys()].sort((left, right) => position(left) - position(right) || left.localeCompare(right))
  const layout = doc.share.has(workbookLayoutRoot) ? doc.getMap<unknown>(workbookLayoutRoot).get('order') : undefined
  const preferred = Array.isArray(layout) ? layout.filter((id): id is string => typeof id === 'string' && stored.has(id)) : []
  const ordered = new Set([...preferred, ...fallback])
  const names = new Set<string>()
  return [...ordered].map(id => {
    let base: string
    try { base = normalizeSheetName(stored.get(id)!) } catch { base = '工作表' }
    let name = base
    for (let index = 2; names.has(name.toLowerCase()); index++) {
      const suffix = ` (${index})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    names.add(name.toLowerCase())
    return { id, name }
  })
}

export function setWorkbookSheetName(doc: Y.Doc, id: string, input: string) {
  const name = normalizeSheetName(input)
  if (!sheetIdPattern.test(id)) throw new TypeError('Invalid sheet ID')
  if (listWorkbookSheets(doc).some(sheet => sheet.id !== id && sheet.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('已有同名工作表')
  }
  doc.getMap<string | null>(workbookRoot).set(id, name)
}

export function countVisibleSheets<T>(entries: Y.Map<T>) {
  let count = entries.has(MAIN_SHEET_ID) ? 0 : 1
  for (const [id, name] of entries) {
    if (sheetIdPattern.test(id) && typeof name === 'string') count++
  }
  return Math.max(1, count)
}

export function checkSheetCapacity(count: number, maxSheets: number | undefined) {
  if (maxSheets === undefined) return
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 0) throw new RangeError('maxSheets must be a non-negative safe integer')
  if (count > maxSheets) throw new RangeError(`工作簿最多允许 ${maxSheets} 张工作表`)
}

export function addWorkbookSheet(doc: Y.Doc, name: string, options: { maxSheets?: number } = {}) {
  const id = makeSheetId()
  const entries = doc.getMap<string | null>(workbookRoot)
  if (options.maxSheets !== undefined) checkSheetCapacity(countVisibleSheets(entries) + 1, options.maxSheets)
  doc.transact(() => {
    const reopenMain = entries.get(MAIN_SHEET_ID) === null && ![...entries.values()].some(value => typeof value === 'string')
    setWorkbookSheetName(doc, id, name)
    if (reopenMain) entries.set(MAIN_SHEET_ID, '工作表1')
    doc.getArray<string>(workbookOrderRoot).push([id])
  })
  return id
}

export function removeWorkbookSheet(doc: Y.Doc, id: string) {
  const sheets = listWorkbookSheets(doc)
  if (!sheets.some(sheet => sheet.id === id) || sheets.length < 2) throw new Error('工作簿至少需要一张工作表')
  doc.getMap<string | null>(workbookRoot).set(id, null)
}

/** Moves a tab before another tab, or to the end if beforeId is omitted. */
export function moveWorkbookSheet(doc: Y.Doc, id: string, beforeId?: string) {
  const sheets = listWorkbookSheets(doc).map(sheet => sheet.id)
  if (!sheets.includes(id) || (beforeId !== undefined && !sheets.includes(beforeId))) throw new RangeError('工作表不存在')
  if (id === beforeId) return
  const next = sheets.filter(sheet => sheet !== id)
  next.splice(beforeId === undefined ? next.length : next.indexOf(beforeId), 0, id)
  if (next.every((sheet, index) => sheet === sheets[index])) return
  // One map value keeps a complete ordering atomic across concurrent moves.
  // Creation still appends sheet IDs once, so concurrent additions are retained.
  doc.getMap<string[]>(workbookLayoutRoot).set('order', next)
}
