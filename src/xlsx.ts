import type * as Y from 'yjs'
import type { Cell, CellValue, RowModel, Worksheet, WorksheetModel } from 'exceljs'
import { FormulaBook } from './formulas'
import { getSheetMaps, readSheetSnapshot } from './model'
import type { CellStyle } from './model-schema'
import { mergeKey, parseCellKey } from './model-schema'
import { SheetCoordinates } from './sheetCoordinates'
import { imageLabel, readCellImage } from './cellImage'
import { cellKey, type CellPosition, type CellRange } from './range'
import { listWorkbookSheets, MAIN_SHEET_ID, makeSheetId, normalizeSheetName, workbookOrderRoot, workbookRoot } from './workbookModel'

const maxRows = 100000
const maxColumns = 16384
const maxCells = 100000
const maxSheets = 32
export const MAX_XLSX_BYTES = 10 * 1024 * 1024
const maxInflated = 48 * 1024 * 1024
const maxMergeArea = 10000
const maxMerges = 1000
const borderSides = ['top', 'right', 'bottom', 'left'] as const
const numberFormats = { general: 'General', number: '#,##0.########', date: 'yyyy-mm-dd', percent: '0.00%' } as const
export type XlsxImportOptions = { replaceBlankMain?: boolean; canApply?: () => boolean }

type ImportCell = { key: string; value: string; formula: boolean; style: CellStyle }
type ImportSheet = {
  name: string; cells: ImportCell[]; merges: CellRange[]
  rowHeights: Array<[string, number]>; columnWidths: Array<[string, number]>
}

function parseAddress(address: string): CellPosition {
  const parts = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address)
  if (!parts) throw new Error('Excel 单元格地址无效')
  const column = [...parts[1].toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
  const row = Number(parts[2]) - 1
  if (row >= maxRows || column >= maxColumns) throw new RangeError('Excel 工作表尺寸超出限制')
  return { row, column }
}

function parseMerge(value: string): CellRange {
  const [left, right, extra] = value.split(':')
  if (!left || !right || extra !== undefined) throw new Error('Excel 合并区域无效')
  const start = parseAddress(left), end = parseAddress(right)
  if (start.row > end.row || start.column > end.column || (end.row - start.row + 1) * (end.column - start.column + 1) > maxMergeArea) {
    throw new RangeError('Excel 合并区域过大或无效')
  }
  return { start, end }
}

// Check the central directory before a ZIP reader allocates XML and merge data.
function checkZip(bytes: ArrayBuffer) {
  if (bytes.byteLength > MAX_XLSX_BYTES) throw new RangeError('Excel 文件最多 10 MB')
  const data = new DataView(bytes)
  let directory = bytes.byteLength - 22
  const minimum = Math.max(0, directory - 65535)
  for (; directory >= minimum; directory--) {
    if (data.getUint32(directory, true) === 0x06054b50 && directory + 22 + data.getUint16(directory + 20, true) === bytes.byteLength) break
  }
  if (directory < minimum) throw new Error('无法读取 XLSX 压缩包')
  const entries = data.getUint16(directory + 10, true)
  const end = data.getUint32(directory + 12, true) + data.getUint32(directory + 16, true)
  let offset = data.getUint32(directory + 16, true)
  let total = 0
  if (end > directory || entries > 2048 || data.getUint32(directory + 4, true) !== 0) throw new Error('不支持此 XLSX 压缩包')
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || data.getUint32(offset, true) !== 0x02014b50 || (data.getUint16(offset + 8, true) & 1)) {
      throw new Error('不支持此 XLSX 压缩包')
    }
    total += data.getUint32(offset + 24, true)
    if (total > maxInflated) throw new RangeError('Excel 解压后的数据过大')
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true)
  }
  if (offset !== end) throw new Error('XLSX 压缩目录无效')
}

// ExcelJS recognizes SpreadsheetML element names without a prefix. Some valid
// XLSX writers bind this same namespace to a prefix on each part's root.
function normalizeSpreadsheetXml(xml: string) {
  const root = /<([A-Za-z_][\w.-]*):(?:workbook|worksheet|styleSheet|sst)\b([^>]*)>/u.exec(xml)
  if (!root) return xml
  const namespace = [...root[2].matchAll(/\sxmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])([^"']+)\2/gu)]
    .find(match => match[1] === root[1])
  if (namespace?.[3] !== 'http://schemas.openxmlformats.org/spreadsheetml/2006/main') return xml
  const normalized = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|(<\/?)([A-Za-z_][\w.-]*):(?=[A-Za-z_])/gu,
    (match, opening: string | undefined, prefix: string | undefined) => prefix === root[1] ? opening! : match)
  return /\sxmlns\s*=/u.test(root[2]) ? normalized : normalized.replace(namespace[0], namespace[0] + ` xmlns="${namespace[3]}"`)
}

async function preflight(bytes: ArrayBuffer) {
  checkZip(bytes)
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  if (zip.file(/(?:^|\/)vbaProject\.bin$/i).length) throw new Error('请将带宏的 Excel 文件另存为 XLSX 后导入')
  const sheets = zip.file(/^xl\/worksheets\/[^/]+\.xml$/i)
  if (sheets.length > maxSheets) throw new RangeError('Excel 最多支持 32 张工作表')
  let cellCount = 0
  let mergeCount = 0
  let mergeArea = 0
  let normalized = false
  const normalize = (name: string, xml: string) => {
    const compatible = normalizeSpreadsheetXml(xml)
    if (compatible === xml) return
    zip.file(name, compatible)
    normalized = true
  }
  for (const file of sheets) {
    const xml = await file.async('string')
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*\br\s*=\s*["']([^"']+)["']/gi)) parseAddress('A' + match[1])
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b[^>]*\br\s*=\s*["']([^"']+)["']/gi)) {
      parseAddress(match[1])
      if (++cellCount > maxCells) throw new RangeError('Excel 最多导入十万个单元格')
    }
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?mergeCell\b[^>]*\bref\s*=\s*["']([^"']+)["']/gi)) {
      const { start, end } = parseMerge(match[1])
      mergeArea += (end.row - start.row + 1) * (end.column - start.column + 1)
      if (++mergeCount > maxMerges || mergeArea > maxCells) throw new RangeError('Excel 合并区域过多')
    }
    normalize(file.name, xml)
  }
  for (const name of ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']) {
    const file = zip.file(name)
    if (file) normalize(name, await file.async('string'))
  }
  return normalized ? zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }) : bytes
}

function toCss(argb?: string) {
  return argb && /^[a-f0-9]{8}$/i.test(argb) ? '#' + argb.slice(2).toLowerCase() : undefined
}
function toArgb(value?: string) {
  const match = /^#([a-f0-9]{3}|[a-f0-9]{6})$/i.exec(value ?? '')?.[1]
  return match && ('FF' + (match.length === 3 ? [...match].map(char => char + char).join('') : match)).toUpperCase()
}

function readStyle(cell: Cell): CellStyle {
  const style: CellStyle = {}
  const { font, fill, alignment, border, numFmt } = cell
  if (font?.bold) style.bold = true
  if (font?.italic) style.italic = true
  if (font?.underline) style.underline = true
  if (font?.strike) style.strike = true
  if (font?.size && font.size > 0) style.fontSize = font.size * 4 / 3
  const color = toCss(font?.color?.argb)
  const background = fill?.type === 'pattern' && fill.pattern === 'solid' ? toCss(fill.fgColor?.argb) : undefined
  if (color) style.color = color
  if (background) style.background = background
  if (alignment?.wrapText) style.wrap = true
  const align = alignment?.horizontal
  if (align === 'left' || align === 'center' || align === 'right') style.align = align
  const sides = borderSides.filter(side => border?.[side]?.style)
  if (sides.length) style.border = Object.fromEntries(sides.map(side => [side, true]))
  const format = numFmt?.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
  if (cell.value instanceof Date || (format && /[ydh]/i.test(format))) style.format = 'date'
  else if (format?.includes('%')) style.format = 'percent'
  else if (format && /[0#]/.test(format)) style.format = 'number'
  return style
}

function readValue(cell: Cell): Pick<ImportCell, 'value' | 'formula'> {
  const formula = cell.formula
  if (formula) return { value: '=' + formula, formula: true }
  const value = cell.value
  let text = ''
  if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object' && value) {
    if ('richText' in value) text = value.richText.map(part => part.text).join('')
    else if ('text' in value) text = value.text
    else if ('error' in value) text = value.error
  } else if (value !== null && value !== undefined) text = String(value)
  return { value: text.startsWith('=') ? "'" + text : text, formula: false }
}

function readWorksheet(sheet: Worksheet): ImportSheet {
  // ExcelJS exposes sparse rows with string addresses in its runtime model.
  const { rows, merges } = sheet.model as WorksheetModel & { rows: Array<Omit<RowModel, 'cells'> & { cells: Array<{ address: string }> }> }
  if (merges.length > maxMerges) throw new RangeError('Excel 合并区域过多')
  const cells: ImportCell[] = []
  const rowHeights: ImportSheet['rowHeights'] = []
  for (const row of rows) {
    if (row.number > maxRows) throw new RangeError('Excel 工作表行数超出限制')
    if (row.height && row.height > 0) rowHeights.push([String(row.number - 1), row.height * 4 / 3])
    for (const model of row.cells) {
      const cell = sheet.getCell(model.address)
      if (cell.isMerged && cell.master.address !== cell.address) continue
      const key = cellKey(parseAddress(cell.address))
      const style = readStyle(cell)
      const value = readValue(cell)
      if (value.value || Object.keys(style).length) cells.push({ key, style, ...value })
    }
  }
  const columnWidths: ImportSheet['columnWidths'] = []
  for (const column of sheet.columns ?? []) {
    const { number, width } = column
    if (number !== undefined && number > maxColumns) throw new RangeError('Excel 工作表列数超出限制')
    if (column.isCustomWidth && number && width && width > 0) columnWidths.push([String(number - 1), width * 7 + 5])
  }
  return { name: normalizeSheetName(sheet.name), cells, merges: merges.map(parseMerge), rowHeights, columnWidths }
}

/** Imports a workbook into the shared Y.Doc in one transaction. Existing sheets are preserved. */
export async function importXlsx(document: Y.Doc, input: ArrayBuffer, options: XlsxImportOptions = {}): Promise<string[]> {
  const compatible = await preflight(input)
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(compatible)
  if (!workbook.worksheets.length || workbook.worksheets.length > maxSheets) throw new RangeError('Excel 工作表数量无效')
  const sheets = workbook.worksheets.map(readWorksheet)
  if (sheets.reduce((total, sheet) => total + sheet.cells.length, 0) > maxCells) throw new RangeError('Excel 最多导入十万个单元格')
  if (options.canApply && !options.canApply()) throw new Error('当前无法编辑工作簿，导入已取消')
  const existing = listWorkbookSheets(document)
  const mayReplaceBlank = options.replaceBlankMain && existing.length === 1 && existing[0].id === MAIN_SHEET_ID && existing[0].name === '工作表1'
  const main = mayReplaceBlank ? readSheetSnapshot(document) : undefined
  const replaceBlank = main && main.rowCount === 1 && main.columnCount === 1 && !Object.values(getSheetMaps(document)).some(map => map.size)
  const names = new Set((replaceBlank ? [] : existing).map(sheet => sheet.name.toLowerCase()))
  const imports = sheets.map((sheet, index) => {
    const base = sheet.name
    let name = base
    for (let i = 2; names.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    names.add(name.toLowerCase())
    return { sheet, name, id: replaceBlank && index === 0 ? MAIN_SHEET_ID : makeSheetId() }
  })
  const aliases = new Map(imports.map(({ sheet, id }) => [sheet.name.toLowerCase(), id]))
  document.transact(() => {
    const entries = document.getMap<string>(workbookRoot)
    for (const { name, id } of imports) entries.set(id, name)
    document.getArray<string>(workbookOrderRoot).push(imports.map(sheet => sheet.id))
    const formulas = new FormulaBook(document)
    for (const { sheet, id } of imports) {
      const maps = getSheetMaps(document, id)
      for (const { key, value, formula, style } of sheet.cells) {
        if (value) maps.cells.set(key, formula ? formulas.store(value, id, aliases) : value)
        if (Object.keys(style).length) maps.styles.set(key, JSON.stringify(style))
      }
      for (const [key, value] of sheet.rowHeights) maps.rowHeights.set(key, value)
      for (const [key, value] of sheet.columnWidths) maps.columnWidths.set(key, value)
      for (const range of sheet.merges) maps.merges.set(mergeKey(range), '1')
    }
  })
  return imports.map(sheet => sheet.id)
}

function writeStyle(cell: Cell, style: CellStyle) {
  const color = toArgb(style.color), background = toArgb(style.background)
  cell.font = { bold: style.bold, italic: style.italic, underline: style.underline, strike: style.strike,
    size: style.fontSize === undefined ? undefined : style.fontSize * 3 / 4, color: color ? { argb: color } : undefined }
  if (background) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: background } }
  if (style.align || style.wrap) cell.alignment = { horizontal: style.align, wrapText: style.wrap }
  if (style.border) cell.border = Object.fromEntries(borderSides.filter(side => style.border?.[side]).map(side => [side, { style: 'thin' }]))
  if (style.format) cell.numFmt = numberFormats[style.format]
}

function writeValue(value: string, style: CellStyle | undefined, result: string | boolean | number | null): CellValue {
  if (value.startsWith("'=")) return value.slice(1)
  if (value.startsWith('=')) {
    const computed = typeof result === 'string' && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|NUM!|N\/A|NULL!|CYCLE!)/.test(result) ? undefined : result ?? undefined
    return { formula: value.slice(1), result: computed }
  }
  if (style?.format === 'date' && /^\d{4}-\d\d-\d\d/.test(value)) {
    const date = new Date(value)
    if (Number.isFinite(date.getTime())) return date
  }
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) && value.replace(/[^0-9]/g, '').length <= 15) return Number(value)
  if (/^(TRUE|FALSE)$/i.test(value)) return value.toUpperCase() === 'TRUE'
  return value
}

/** Exports the shared workbook in canonical row order. Hosts authorize file access. */
export async function exportXlsx(document: Y.Doc): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.calcProperties.fullCalcOnLoad = true
  const sheets = listWorkbookSheets(document)
  if (sheets.length > maxSheets) throw new RangeError('Excel 最多支持 32 张工作表')
  const formulas = new FormulaBook(document)
  let totalCells = 0
  for (const { id, name } of sheets) {
    const sheet = workbook.addWorksheet(name)
    const snapshot = readSheetSnapshot(document, { maxRows, maxColumns, maxMerges, maxMergeArea }, id)
    const keys = new Set([...Object.keys(snapshot.cells), ...Object.keys(snapshot.styles)])
    totalCells += keys.size
    if (totalCells > maxCells) throw new RangeError('Excel 最多导出十万个单元格')
    const coordinates = new SheetCoordinates(document, id)
    for (const key of keys) {
      const { row, column } = parseCellKey(key)!
      const cell = sheet.getCell(row + 1, column + 1)
      const style = snapshot.styles[key]
      const raw = snapshot.cells[key]
      const image = readCellImage(raw)
      const value = image ? undefined : raw
      if (image) cell.value = imageLabel(image)
      if (value !== undefined) {
        if (value.length > 32767) throw new RangeError('Excel 单元格文本最多 32767 个字符')
        cell.value = writeValue(value, style, value.startsWith('=') ? formulas.value(id, coordinates.cellId(key)!) : null)
      }
      if (style) writeStyle(cell, style)
    }
    for (const [key, height] of Object.entries(snapshot.rowHeights)) sheet.getRow(Number(key) + 1).height = height * 3 / 4
    for (const [key, width] of Object.entries(snapshot.columnWidths)) sheet.getColumn(Number(key) + 1).width = Math.max(1, (width - 5) / 7)
    for (const { start, end } of snapshot.merges) sheet.mergeCellsWithoutStyle(start.row + 1, start.column + 1, end.row + 1, end.column + 1)
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
