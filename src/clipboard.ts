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
type ClipboardPayload = { values: string[][]; styles: Array<Array<CellStyle | null>> }
type ClipboardHost = {
  sheet: SheetDocument
  selection: TableSelection
  editing: CellEditor
  formatting: CellFormatting
  canEdit(): boolean
  pasteImage?(file: File): void
  dimensions(): { rows: number; columns: number }
  render(): void
  origin: unknown
}
function isPayload(value: unknown): value is ClipboardPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as ClipboardPayload
  return Array.isArray(payload.values) && payload.values.length > 0
    && payload.values.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))
    && Array.isArray(payload.styles) && payload.styles.every(row => Array.isArray(row) && row.every(style => style === null || isCellStyle(style)))
}

export class TableClipboard {
  constructor(private readonly host: ClipboardHost) {}
  private payload(): ClipboardPayload | undefined {
    const { sheet, selection, formatting } = this.host
    if (!selection.focus) return undefined
    const range = selectionRange(selection.anchor, selection.focus)
    const values: string[][] = []
    const styles: Array<Array<CellStyle | null>> = []
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
    }
    return { values, styles }
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
    const text = event.clipboardData?.getData('text/plain')?.replace(/^\uFEFF/, '')
    if (!text) return
    editing.finish(false)
    let rows = text.replace(/\r\n?/g, '\n').split('\n').filter((row, index, all) => !(index === all.length - 1 && row === '')).map(row => row.split('\t'))
    let styles: ClipboardPayload['styles'] | undefined
    try {
      const payload = JSON.parse(event.clipboardData?.getData(clipboardMime) ?? '')
      if (isPayload(payload)) { rows = payload.values; styles = payload.styles }
    } catch { /* Plain-text clipboard data remains available. */ }
    const start = selection.focus
    if (rows.some((row, r) => row.some((_, c) => sheet.isCellLocked(cellKey({ row: start.row + r, column: start.column + c }))))) return
    const dimensions = this.host.dimensions()
    if (rows.some((row, r) => row.some((value, c) => start.row + r < dimensions.rows && start.column + c < dimensions.columns
      && !sheet.features.accepts(cellKey({ row: start.row + r, column: start.column + c }), normalizeCellText(value))))) return
    sheet.doc.transact(() => rows.forEach((row, r) => row.forEach((value, c) => {
      const position = { row: start.row + r, column: start.column + c }
      if (position.row >= dimensions.rows || position.column >= dimensions.columns) return
      const key = cellKey(position)
      const image = styles && readCellImage(value)
      if (image) sheet.cells.set(key, encodeCellImage(image))
      else sheet.writeCell(key, normalizeCellText(value))
      if (styles) {
        const style = styles[r]?.[c]
        if (style) sheet.styles.set(key, JSON.stringify(style))
        else sheet.styles.delete(key)
      }
    })), this.host.origin)
    selection.anchor = start
    selection.focus = { row: Math.min(dimensions.rows - 1, start.row + rows.length - 1), column: Math.min(dimensions.columns - 1, start.column + Math.max(...rows.map(row => row.length)) - 1) }
    this.host.render()
  }

  private plainText(payload: ClipboardPayload) {
    return payload.values.map(row => row.map(value => {
      const image = readCellImage(value)
      return image ? imageLabel(image) : value
    }).join('\t')).join('\n')
  }
}
