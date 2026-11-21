import { cellKey } from './range'
import { normalizeCellText } from './unicode'
import type { CellStyle } from './model-schema'
import { isCellStyle } from './model-validation'
import { selectionRange } from './selection'
import type { SheetDocument } from './sheetDocument'
import type { TableSelection } from './tableSelection'
import type { CellEditor } from './cellEditor'
import type { CellFormatting } from './formatting'
import { encodeCellImage, imageLabel, readCellImage } from './cellImage'
const clipboardMime = 'application/x-colwork-cells'
type ClipboardPayload = { values: string[][]; styles: Array<Array<CellStyle | null>>; source?: { rows: number[]; column: number } }
type ClipboardHost = {
  sheet: SheetDocument
  selection: TableSelection
  editing: CellEditor
  formatting: CellFormatting
  canEdit(): boolean
  pasteImage?(file: File): void
  resize(rows: number, columns: number): void
  reject(message: string): void
  stopCapturing(): void
  render(): void
  origin: unknown
}
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function isPayload(value: unknown): value is ClipboardPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as ClipboardPayload
  return Array.isArray(payload.values) && payload.values.length > 0
    && payload.values.every(row => Array.isArray(row) && row.length > 0 && row.every(cell => typeof cell === 'string'))
    && Array.isArray(payload.styles) && payload.styles.every(row => Array.isArray(row) && row.every(style => style === null || isCellStyle(style)))
    && (payload.source === undefined || (payload.source && isIndex(payload.source.column) && Array.isArray(payload.source.rows)
      && payload.source.rows.length === payload.values.length && payload.source.rows.every(isIndex)))
}

function parseTableText(text: string) {
  const input = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  const quoted = /"((?:[^"]|"")*)"(?=[\t\n]|$)/y
  const delimiter = /[\t\n]/g
  let row: string[] = []
  for (let offset = 0; offset < input.length;) {
    quoted.lastIndex = offset
    const match = quoted.exec(input)
    let end: number
    if (match) {
      row.push(match[1].replace(/""/g, '"'))
      end = quoted.lastIndex
    } else {
      delimiter.lastIndex = offset
      end = delimiter.exec(input)?.index ?? input.length
      row.push(input.slice(offset, end))
    }
    offset = end + 1
    if (input[end] !== '\t') {
      rows.push(row)
      row = []
    } else if (offset === input.length) {
      row.push('')
      rows.push(row)
    }
  }
  return rows
}

export class TableClipboard {
  constructor(private readonly host: ClipboardHost) {}
  private payload(): ClipboardPayload | undefined {
    const { sheet, selection, formatting } = this.host
    if (!selection.focus) return undefined
    const range = selectionRange(selection.anchor, selection.focus)
    const values: string[][] = []
    const styles: Array<Array<CellStyle | null>> = []
    const source = { rows: [] as number[], column: range.start.column }
    for (let row = range.start.row; row <= range.end.row; row++) {
      const valueRow: string[] = []
      const styleRow: Array<CellStyle | null> = []
      for (let column = range.start.column; column <= range.end.column; column++) {
        const key = cellKey({ row, column })
        const raw = sheet.cells.get(key)
        valueRow.push(raw && readCellImage(raw) ? raw : sheet.readCell(key))
        const style = formatting.readStyle(key)
        styleRow.push(Object.keys(style).length ? style : null)
      }
      values.push(valueRow)
      styles.push(styleRow)
      source.rows.push(sheet.coordinates.canonicalRow(row) ?? row)
    }
    return { values, styles, source }
  }
  copySelection() {
    const payload = this.payload()
    const text = payload && this.plainText(payload)
    if (text) void navigator.clipboard?.writeText(text)
  }
  readonly onCopy = (event: ClipboardEvent) => {
    // Native copying inside an editor must preserve the textarea's own selection.
    if (event.target instanceof HTMLTextAreaElement) return
    const payload = this.payload()
    if (!payload || !event.clipboardData) return
    event.clipboardData.setData('text/plain', this.plainText(payload))
    event.clipboardData.setData(clipboardMime, JSON.stringify(payload))
    event.preventDefault()
  }
  readonly onPaste = (event: ClipboardEvent) => {
    const image = Array.from(event.clipboardData?.files ?? []).find(file => file.type.startsWith('image/'))
    if (image && this.host.pasteImage && this.host.canEdit() && this.host.selection.focus) {
      event.preventDefault()
      event.stopPropagation()
      this.host.pasteImage(image)
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    event.preventDefault()
    event.stopPropagation()
    const { selection, sheet, editing } = this.host
    if (!this.host.canEdit() || !selection.focus) return
    const text = event.clipboardData?.getData('text/plain')?.replace(/^\uFEFF/, '') ?? ''
    let payload: ClipboardPayload | undefined
    try {
      const candidate = JSON.parse(event.clipboardData?.getData(clipboardMime) ?? '')
      if (isPayload(candidate)) payload = candidate
    } catch { /* Plain-text clipboard data remains available. */ }
    const rows = payload?.values ?? parseTableText(text)
    if (!rows.length) return
    editing.finish(false)
    const start = selection.focus
    const end = { row: start.row + rows.length - 1, column: start.column }
    const writes: Array<{ id: string; raw: string; style?: CellStyle | null }> = []
    for (const [r, row] of rows.entries()) {
      const targetRow = start.row + r
      const canonicalRow = sheet.coordinates.canonicalRow(targetRow)
      if (canonicalRow === undefined) return this.host.reject('粘贴范围超出筛选后的可见行，请清除筛选后重试')
      end.column = Math.max(end.column, start.column + row.length - 1)
      for (const [c, input] of row.entries()) {
        const key = cellKey({ row: targetRow, column: start.column + c })
        const id = sheet.coordinates.cellId(key)
        if (id === undefined) return this.host.reject('粘贴范围超出工作表')
        if (sheet.isCellLocked(key)) return this.host.reject('粘贴范围包含锁定单元格')
        const value = normalizeCellText(input)
        const image = payload && readCellImage(value)
        const raw = image ? encodeCellImage(image)
          : payload?.source ? sheet.formulas.shift(value, sheet.sheetId, canonicalRow - payload.source.rows[r], start.column - payload.source.column)
          : sheet.formulas.store(value, sheet.sheetId)
        if (!sheet.features.accepts(key, image ? value : sheet.formulas.source(raw))) return this.host.reject('粘贴内容不符合数据验证规则')
        writes.push({ id, raw, style: payload ? payload.styles[r]?.[c] ?? null : undefined })
      }
    }
    this.host.resize(end.row + 1, end.column + 1)
    selection.anchor = start
    selection.focus = end
    this.host.stopCapturing()
    sheet.doc.transact(() => {
      for (const { id, raw, style } of writes) {
        sheet.cells.raw.set(id, raw)
        if (style) sheet.styles.raw.set(id, JSON.stringify(style))
        else if (style === null) sheet.styles.raw.delete(id)
      }
    }, this.host.origin)
    this.host.stopCapturing()
    this.host.render()
  }

  private plainText(payload: ClipboardPayload) {
    return payload.values.map(row => row.map(raw => {
      const image = readCellImage(raw)
      const value = image ? imageLabel(image) : raw
      return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value
    }).join('\t')).join('\n')
  }
}
