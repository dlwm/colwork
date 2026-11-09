import type * as Y from 'yjs'

export const MAIN_SHEET_ID = 'main'
export const workbookRoot = 'colwork-workbook'
export const workbookOrderRoot = 'colwork-workbook-order'
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
  const order = new Map(doc.getArray<string>(workbookOrderRoot).toArray().map((id, index) => [id, index]))
  const stored = [...entries].filter(([id, name]) => sheetIdPattern.test(id) && typeof name === 'string')
    .sort(([left], [right]) => (order.get(left) ?? -1) - (order.get(right) ?? -1) || left.localeCompare(right))
  if (!entries.has(MAIN_SHEET_ID)) stored.unshift([MAIN_SHEET_ID, '工作表1'])
  if (!stored.length) return [{ id: MAIN_SHEET_ID, name: '工作表1' }]
  const names = new Set<string>()
  return stored.map(([id, value]) => {
    let base: string
    try { base = normalizeSheetName(value!) } catch { base = '工作表' }
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

export function addWorkbookSheet(doc: Y.Doc, name: string) {
  const id = makeSheetId()
  doc.transact(() => {
    setWorkbookSheetName(doc, id, name)
    doc.getArray<string>(workbookOrderRoot).push([id])
  })
  return id
}

export function removeWorkbookSheet(doc: Y.Doc, id: string) {
  const sheets = listWorkbookSheets(doc)
  if (!sheets.some(sheet => sheet.id === id) || sheets.length < 2) throw new Error('工作簿至少需要一张工作表')
  doc.getMap<string | null>(workbookRoot).set(id, null)
}
