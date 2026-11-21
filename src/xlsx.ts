import type * as Y from 'yjs'
import type { Cell, CellValue, ConditionalFormattingOptions, DataValidation, Image, RowModel, Worksheet, WorksheetModel } from 'exceljs'
import { excelColumn, FormulaBook } from './formulas'
import { getSheetMaps, readSheetSnapshot } from './model'
import type { CellStyle } from './model-schema'
import { mergeKey, parseCellKey } from './model-schema'
import { SheetCoordinates } from './sheetCoordinates'
import { encodeCellImage, imageLabel, readCellImage, type ColworkImageRef } from './cellImage'
import { cellKey, type CellPosition, type CellRange } from './range'
import { getSheetFeatureMaps, isConditionalFormat, isDataValidation, readFeature, type ColworkConditionalFormat, type ColworkDataValidation } from './sheetFeatures'
import { checkSheetCapacity, listWorkbookSheets, MAIN_SHEET_ID, makeSheetId, normalizeSheetName, workbookOrderRoot, workbookRoot } from './workbookModel'

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
export type ColworkXlsxImage = { bytes: Uint8Array; mimeType: string }
export type XlsxImportOptions = {
  replaceBlankMain?: boolean
  /** Optional host limit for the resulting visible workbook, up to the converter's limit. */
  maxSheets?: number
  canApply?: () => boolean
  uploadImage?: (image: ColworkXlsxImage & { name: string }) => Promise<ColworkImageRef>
}
export type XlsxExportOptions = {
  readImage?: (image: ColworkImageRef) => Promise<ColworkXlsxImage | undefined>
}
const imageMime = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' } as const
const maxXlsxImages = 300

type ImportCell = { key: string; value: string; formula: boolean; style: CellStyle }
type ImportSheet = {
  name: string; cells: ImportCell[]; merges: CellRange[]
  rowHeights: Array<[string, number]>; columnWidths: Array<[string, number]>
  validation: Array<[string, ColworkDataValidation]>
  conditional: Array<[string, ColworkConditionalFormat]>
  imageRefs: Map<string, string>
}

function parseAddress(address: string): CellPosition {
  const parts = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address)
  if (!parts) throw new Error('Excel 单元格地址无效')
  const column = [...parts[1].toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
  const row = Number(parts[2]) - 1
  if (row >= maxRows || column >= maxColumns) throw new RangeError('Excel 工作表尺寸超出限制')
  return { row, column }
}

function parseMerge(value: string, area = maxMergeArea): CellRange {
  const [left, right, extra] = value.split(':')
  if (!left || right === '' || extra !== undefined) throw new Error('Excel 合并区域无效')
  const start = parseAddress(left), end = parseAddress(right ?? left)
  if (start.row > end.row || start.column > end.column || (end.row - start.row + 1) * (end.column - start.column + 1) > area) {
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
  let validationArea = 0
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
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?dataValidation\b[^>]*\bsqref\s*=\s*["']([^"']+)["']/gi)) {
      for (const address of match[1].trim().split(/\s+/)) {
        const { start, end } = parseMerge(address, maxCells)
        validationArea += (end.row - start.row + 1) * (end.column - start.column + 1)
        if (validationArea > maxCells) throw new RangeError('Excel 数据验证覆盖范围过大')
      }
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

function readValidationRules(rules: Record<string, DataValidation>): ImportSheet['validation'] {
  const byRule = new Map<string, { rule: ColworkDataValidation; positions: CellPosition[] }>()
  for (const [address, rule] of Object.entries(rules)) {
    const formula = rule.formulae?.[0]
    if (rule.type !== 'list' || typeof formula !== 'string' || !/^"[^"]*"$/.test(formula)) continue
    let group = byRule.get(formula)
    if (!group) {
      const definition = { choices: [...new Set(formula.slice(1, -1).split(','))] }
      if (!isDataValidation(definition)) continue
      group = { rule: definition, positions: [] }
      byRule.set(formula, group)
    }
    group.positions.push(parseAddress(address))
  }
  const result: ImportSheet['validation'] = []
  for (const { rule, positions } of byRule.values()) {
    positions.sort((a, b) => a.row - b.row || a.column - b.column)
    const ranges: CellRange[] = []
    const previousBySpan = new Map<string, CellRange>()
    for (let index = 0; index < positions.length;) {
      const start = positions[index++]
      let end = start
      while (positions[index]?.row === start.row && positions[index].column === end.column + 1) end = positions[index++]
      const span = `${start.column}:${end.column}`
      const previous = previousBySpan.get(span)
      if (previous && previous.end.row + 1 === start.row) previous.end = end
      else {
        const range = { start, end }
        previousBySpan.set(span, range)
        ranges.push(range)
      }
    }
    for (const range of ranges) result.push([mergeKey(range), rule])
  }
  return result
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
  const model = sheet.model as WorksheetModel & {
    dataValidations?: Record<string, DataValidation>
    conditionalFormattings?: ConditionalFormattingOptions[]
  }
  const validation = readValidationRules(model.dataValidations ?? {})
  const conditional: ImportSheet['conditional'] = []
  for (const group of model.conditionalFormattings ?? []) {
    for (const rule of group.rules) {
      const fill = rule.style?.fill
      if (fill?.type !== 'pattern' || fill.pattern !== 'solid') continue
      const background = toCss(fill.fgColor?.argb)
      let operator: ColworkConditionalFormat['operator']
      let value: string
      if (rule.type === 'containsText' && rule.operator === 'containsText') { operator = 'contains'; value = rule.text ?? '' }
      else if (rule.type === 'containsText' && rule.operator === 'containsBlanks') { operator = 'empty'; value = '' }
      else if (rule.type === 'cellIs' && ['equal', 'greaterThan', 'lessThan'].includes(rule.operator ?? '')) {
        operator = rule.operator === 'equal' ? 'equals' : rule.operator === 'greaterThan' ? 'greater' : 'less'
        const expression = String(rule.formulae?.[0] ?? '')
        if (/^"(?:""|[^"])*"$/.test(expression)) value = expression.slice(1, -1).replace(/""/g, '"')
        else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(expression)) value = expression
        else continue
      } else continue
      const definition = { operator, value, background }
      if (!isConditionalFormat(definition)) continue
      for (const address of group.ref.trim().split(/\s+/)) conditional.push([mergeKey(parseMerge(address, maxRows * maxColumns)), definition])
      break
    }
  }
  return { name: normalizeSheetName(sheet.name), cells, merges: merges.map(value => parseMerge(value)), rowHeights, columnWidths,
    conditional, validation, imageRefs: new Map() }
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
  const importTarget = () => {
    const existing = listWorkbookSheets(document)
    const mayReplaceBlank = options.replaceBlankMain && existing.length === 1 && existing[0].id === MAIN_SHEET_ID && existing[0].name === '工作表1'
    const main = mayReplaceBlank ? readSheetSnapshot(document) : undefined
    const replaceBlank = !!main && main.rowCount === 1 && main.columnCount === 1
      && ![...Object.values(getSheetMaps(document)), ...Object.values(getSheetFeatureMaps(document))].some(map => map.size)
    const count = sheets.length + existing.length - Number(replaceBlank)
    checkSheetCapacity(count, options.maxSheets)
    checkSheetCapacity(count, maxSheets)
    return { existing, replaceBlank }
  }
  const target = importTarget()
  if (options.uploadImage) {
    const distinct = new Map<number, ColworkImageRef>()
    let anchors = 0
    for (const [index, sheet] of workbook.worksheets.entries()) {
      for (const drawing of sheet.getImages()) {
        if (++anchors > maxXlsxImages) throw new RangeError('Excel 最多导入 300 张图片')
        if (options.canApply && !options.canApply()) throw new Error('当前无法编辑工作簿，导入已取消')
        const row = drawing.range.tl.nativeRow, column = drawing.range.tl.nativeCol
        if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row < 0 || column < 0 || row >= maxRows || column >= maxColumns) continue
        const source = Number(drawing.imageId)
        const image = workbook.getImage(source)
        if (!image?.buffer || !Object.prototype.hasOwnProperty.call(imageMime, image.extension)) continue
        const target = { row, column }
        const merge = sheets[index].merges.find(({ start, end }) =>
          row >= start.row && row <= end.row && column >= start.column && column <= end.column)
        const key = cellKey(merge?.start ?? target)
        if (sheets[index].imageRefs.has(key)) continue
        let ref = distinct.get(source)
        if (!ref) {
          ref = await options.uploadImage({ bytes: Uint8Array.from(image.buffer as unknown as Uint8Array), mimeType: imageMime[image.extension], name: `image-${source + 1}.${image.extension}` })
          distinct.set(source, ref)
        }
        sheets[index].imageRefs.set(key, encodeCellImage(ref))
      }
    }
  }
  if (options.canApply && !options.canApply()) throw new Error('当前无法编辑工作簿，导入已取消')
  const { existing, replaceBlank } = options.uploadImage ? importTarget() : target
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
    const entries = document.getMap<string | null>(workbookRoot)
    if (!replaceBlank && existing.length === 1 && existing[0].id === MAIN_SHEET_ID && entries.get(MAIN_SHEET_ID) === null) {
      entries.set(MAIN_SHEET_ID, existing[0].name)
    }
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
      for (const [key, image] of sheet.imageRefs) maps.cells.set(key, image)
      const features = getSheetFeatureMaps(document, id)
      for (const [range, rule] of sheet.validation) features.validation.set(range, JSON.stringify(rule))
      for (const [range, rule] of sheet.conditional) features.conditional.set(range, JSON.stringify(rule))
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
export async function exportXlsx(document: Y.Doc, options: XlsxExportOptions = {}): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.calcProperties.fullCalcOnLoad = true
  const sheets = listWorkbookSheets(document)
  if (sheets.length > maxSheets) throw new RangeError('Excel 最多支持 32 张工作表')
  const formulas = new FormulaBook(document)
  let totalCells = 0
  let imageCount = 0
  const images = new Map<string, number | undefined>()
  // Snapshot the source before asynchronous asset retrieval can yield to collaboration updates.
  const sourceSheets = sheets.map(sheet => ({
    ...sheet, snapshot: readSheetSnapshot(document, { maxRows, maxColumns, maxMerges, maxMergeArea, mergeConflicts: 'resolve' }, sheet.id),
    coordinates: new SheetCoordinates(document, sheet.id), features: getSheetFeatureMaps(document, sheet.id),
  })).map(sheet => ({
    ...sheet, validation: [...sheet.features.validation].map(([key, value]) => [sheet.coordinates.mergeRange(key), value] as const),
    conditional: [...sheet.features.conditional].map(([key, value]) => [sheet.coordinates.mergeRange(key), value] as const),
    values: new Map(Object.entries(sheet.snapshot.cells).filter(([, raw]) => raw.startsWith('=')).map(([key]) =>
      [key, formulas.value(sheet.id, sheet.coordinates.cellId(key)!)])),
  }))
  for (const { name, snapshot, validation, conditional, values } of sourceSheets) {
    const sheet = workbook.addWorksheet(name)
    const keys = new Set([...Object.keys(snapshot.cells), ...Object.keys(snapshot.styles)])
    totalCells += keys.size
    if (totalCells > maxCells) throw new RangeError('Excel 最多导出十万个单元格')
    for (const key of keys) {
      const { row, column } = parseCellKey(key)!
      const cell = sheet.getCell(row + 1, column + 1)
      const style = snapshot.styles[key]
      const raw = snapshot.cells[key]
      const image = readCellImage(raw)
      const value = image ? undefined : raw
      if (image) {
        cell.value = imageLabel(image)
        if (options.readImage) {
          if (++imageCount > maxXlsxImages) throw new RangeError('Excel 最多导出 300 张图片')
          if (!images.has(image.id)) {
            const asset = await options.readImage(image)
            const extension = asset && (Object.keys(imageMime) as Image['extension'][]).find(type => imageMime[type] === asset.mimeType)
            images.set(image.id, asset && extension
              ? workbook.addImage({ extension, buffer: Uint8Array.from(asset.bytes) as unknown as Image['buffer'] }) : undefined)
          }
          const imageId = images.get(image.id)
          if (imageId !== undefined) {
            const merge = snapshot.merges.find(range => range.start.row === row && range.start.column === column)
            const end = merge?.end ?? { row, column }
            sheet.addImage(imageId, `${excelColumn(column)}${row + 1}:${excelColumn(end.column)}${end.row + 1}`)
          }
        }
      }
      if (value !== undefined) {
        if (value.length > 32767) throw new RangeError('Excel 单元格文本最多 32767 个字符')
        cell.value = writeValue(value, style, values.get(key) ?? null)
      }
      if (style) writeStyle(cell, style)
    }
    const excelAddress = (row: number, column: number) => excelColumn(column) + (row + 1)
    let validated = 0
    for (const [range, raw] of validation) {
      const rule = readFeature(raw, isDataValidation)
      if (!rule || !range || rule.choices.some(choice => /[,"\r\n]/.test(choice))) continue
      const formula = '"' + rule.choices.join(',') + '"'
      if (formula.length > 255) continue
      validated += (range.end.row - range.start.row + 1) * (range.end.column - range.start.column + 1)
      if (validated > maxCells) throw new RangeError('Excel 数据验证覆盖范围过大')
      const cells = (sheet as Worksheet & { dataValidations: { add(address: string, rule: DataValidation): void } }).dataValidations
      for (let row = range.start.row; row <= range.end.row; row++) {
        for (let column = range.start.column; column <= range.end.column; column++) {
          cells.add(excelAddress(row, column), { type: 'list', allowBlank: true, showErrorMessage: true, formulae: [formula] })
        }
      }
    }
    let priority = 0
    for (const [range, raw] of conditional) {
      const rule = readFeature(raw, isConditionalFormat)
      if (!range || !rule) continue
      const ref = `${excelAddress(range.start.row, range.start.column)}:${excelAddress(range.end.row, range.end.column)}`
      const style = { fill: { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: toArgb(rule.background) } } }
      const base = { priority: ++priority, style }
      if (rule.operator === 'contains' || rule.operator === 'empty') {
        sheet.addConditionalFormatting({ ref, rules: [{ ...base, type: 'containsText',
          operator: rule.operator === 'empty' ? 'containsBlanks' : 'containsText', text: rule.value }] })
      } else {
        const operator = rule.operator === 'greater' ? 'greaterThan' : rule.operator === 'less' ? 'lessThan' : 'equal'
        const value = rule.operator === 'equals' && (!rule.value.trim() || !Number.isFinite(Number(rule.value)))
          ? '"' + rule.value.replace(/"/g, '""') + '"' : Number(rule.value)
        sheet.addConditionalFormatting({ ref, rules: [{ ...base, type: 'cellIs', operator, formulae: [value] }] })
      }
    }
    for (const [key, height] of Object.entries(snapshot.rowHeights)) sheet.getRow(Number(key) + 1).height = height * 3 / 4
    for (const [key, width] of Object.entries(snapshot.columnWidths)) sheet.getColumn(Number(key) + 1).width = Math.max(1, (width - 5) / 7)
    for (const { start, end } of snapshot.merges) sheet.mergeCellsWithoutStyle(start.row + 1, start.column + 1, end.row + 1, end.column + 1)
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
