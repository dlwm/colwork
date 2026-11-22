import { cellKey, type CellPosition } from './range'
import { normalizeCellText } from './unicode'
import { parseCellKey, type CellStyle } from './model-schema'
import { isCellStyle } from './model-validation'
import { selectionRange } from './selection'
import type { SheetDocument } from './sheetDocument'
import type { TableSelection } from './tableSelection'
import type { CellEditor } from './cellEditor'
import type { CellFormatting } from './formatting'
import { encodeCellImage, imageLabel, readCellImage } from './cellImage'
const clipboardMime = 'application/x-colwork-cells'
type ClipboardPayload = {
  values: string[][]
  styles: Array<Array<CellStyle | null>>
  source?: { rows: number[]; column: number }
  results?: Record<string, string>
}
type PasteMode = 'all' | 'values' | 'styles'
type ClipboardHost = {
  viewport: HTMLElement
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
    && (payload.results === undefined || (!!payload.results && typeof payload.results === 'object'
      && !Array.isArray(payload.results) && Object.values(payload.results).every(result => typeof result === 'string')))
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
  private pasteDialog?: HTMLDialogElement
  constructor(private readonly host: ClipboardHost) {}
  private payload(): ClipboardPayload | undefined {
    const { sheet, selection, formatting } = this.host
    if (!selection.focus) return undefined
    const range = selectionRange(selection.anchor, selection.focus)
    const values: string[][] = []
    const styles: Array<Array<CellStyle | null>> = []
    const source = { rows: [] as number[], column: range.start.column }
    const results: Record<string, string> = {}
    for (let row = range.start.row; row <= range.end.row; row++) {
      const valueRow: string[] = []
      const styleRow: Array<CellStyle | null> = []
      for (let column = range.start.column; column <= range.end.column; column++) {
        const key = cellKey({ row, column })
        const raw = sheet.cells.get(key)
        const value = raw && readCellImage(raw) ? raw : sheet.readCell(key)
        valueRow.push(value)
        if (value.startsWith('=')) results[cellKey({ row: row - range.start.row, column: column - range.start.column })] = sheet.displayCell(key)
        const style = formatting.readStyle(key)
        styleRow.push(Object.keys(style).length ? style : null)
      }
      values.push(valueRow)
      styles.push(styleRow)
      source.rows.push(sheet.coordinates.canonicalRow(row) ?? row)
    }
    return { values, styles, source, results }
  }
  copySelection() {
    if (!this.host.selection.focus) return
    const { viewport } = this.host
    const document = viewport.ownerDocument
    viewport.focus({ preventScroll: true })
    // A scripted copy can target the page body even when the viewport has focus.
    let handled = false
    const captureCopy = (event: ClipboardEvent) => {
      this.onCopy(event)
      handled = event.defaultPrevented
    }
    document.addEventListener('copy', captureCopy, true)
    try {
      document.execCommand('copy')
      // WebKit can report false after a canceled copy event has written our formats.
      if (handled) return
    } catch { /* Fall back to the plain-text clipboard API. */ }
    finally { document.removeEventListener('copy', captureCopy, true) }

    const payload = this.payload()
    if (!payload) return
    const clipboard = document.defaultView?.navigator.clipboard
    const reportFailure = () => {
      if (viewport.isConnected) this.host.reject('无法复制到系统剪贴板')
    }
    if (!clipboard) return reportFailure()
    void clipboard.writeText(this.plainText(payload)).catch(reportFailure)
  }
  readonly onCopy = (event: ClipboardEvent) => {
    // Native copying inside an editor must preserve the textarea's own selection.
    if (event.defaultPrevented || event.target instanceof HTMLTextAreaElement) return
    const payload = this.payload()
    if (!payload || !event.clipboardData) return
    event.clipboardData.setData('text/plain', this.plainText(payload))
    event.clipboardData.setData(clipboardMime, JSON.stringify(payload))
    event.preventDefault()
  }

  readonly onDocumentClipboard = (event: ClipboardEvent) => {
    // Firefox can target the previous selection outside the focused viewport.
    const { viewport } = this.host
    const root = viewport.getRootNode() as Document | ShadowRoot
    if (root.activeElement !== viewport || event.composedPath().includes(viewport)) return
    const target = event.target
    if (!(target instanceof Node) || (!target.contains(viewport) && !viewport.parentElement?.contains(target))) return
    if (event.type === 'copy') this.onCopy(event)
    else this.onPaste(event)
  }

  openPasteOptions() {
    const { viewport, selection, sheet, canEdit } = this.host
    if (!canEdit() || !selection.focus || !viewport.parentElement || this.pasteDialog) return
    const id = sheet.coordinates.cellId(cellKey(selection.focus))
    if (id === undefined) return
    const doc = viewport.ownerDocument
    const dialog = doc.createElement('dialog')
    dialog.className = 'colwork-table__feature-dialog colwork-table__paste-dialog'
    dialog.setAttribute('aria-label', '选择性粘贴')
    const label = doc.createElement('label')
    label.textContent = '粘贴方式'
    const mode = doc.createElement('select')
    for (const [value, name] of [['values', '仅粘贴值'], ['styles', '仅粘贴格式']]) {
      const option = doc.createElement('option')
      option.value = value
      option.textContent = name
      mode.append(option)
    }
    label.append(mode)
    const target = doc.createElement('textarea')
    target.rows = 2
    target.placeholder = '按 Ctrl/⌘ + V 粘贴'
    target.setAttribute('aria-label', '粘贴区')
    const cancel = doc.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.onclick = () => this.closePasteOptions()
    dialog.addEventListener('close', () => {
      if (this.pasteDialog === dialog) this.closePasteOptions()
    })
    dialog.addEventListener('paste', event => {
      event.preventDefault()
      event.stopPropagation()
      this.closePasteOptions()
      if (!canEdit()) return
      const key = sheet.coordinates.cellKey(id)
      const start = key && parseCellKey(key)
      if (!start) return this.host.reject('目标单元格已变化，请重新选择')
      this.paste(event.clipboardData, start, mode.value === 'styles' ? 'styles' : 'values')
    })
    mode.onchange = () => target.focus()
    dialog.append(label, target, cancel)
    viewport.focus({ preventScroll: true })
    viewport.parentElement.append(dialog)
    this.pasteDialog = dialog
    dialog.showModal()
    target.focus()
  }

  closePasteOptions() {
    const dialog = this.pasteDialog
    this.pasteDialog = undefined
    dialog?.close()
    dialog?.remove()
  }

  readonly onPaste = (event: ClipboardEvent) => {
    if (event.defaultPrevented) return
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
    const { selection } = this.host
    if (!this.host.canEdit() || !selection.focus) return
    this.paste(event.clipboardData, selection.focus, 'all')
  }

  private paste(clipboard: DataTransfer | null, start: CellPosition, mode: PasteMode) {
    const { selection, sheet, editing } = this.host
    const text = clipboard?.getData('text/plain')?.replace(/^\uFEFF/, '') ?? ''
    let payload: ClipboardPayload | undefined
    try {
      const candidate = JSON.parse(clipboard?.getData(clipboardMime) ?? '')
      if (isPayload(candidate)) payload = candidate
    } catch { /* Plain-text clipboard data remains available. */ }
    if (mode === 'styles' && !payload) return this.host.reject('仅粘贴格式需要从 Colwork 表格复制单元格')
    const rows = payload?.values ?? parseTableText(text)
    if (!rows.length) {
      if (mode === 'values') this.host.reject('剪贴板中没有可粘贴的单元格数据')
      return
    }
    editing.finish(false)
    const end = { row: start.row + rows.length - 1, column: start.column }
    const writes: Array<{ id: string; raw?: string; style?: CellStyle | null }> = []
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
        const style = mode !== 'values' && payload ? payload.styles[r]?.[c] ?? null : undefined
        if (mode === 'styles') { writes.push({ id, style }); continue }
        const value = normalizeCellText(input)
        const image = payload && readCellImage(value)
        if (mode === 'values') {
          const result = normalizeCellText(payload?.results?.[cellKey({ row: r, column: c })]
            ?? (image ? imageLabel(image) : payload && value.startsWith("'=") ? value.slice(1) : value))
          if (!sheet.features.accepts(key, result)) return this.host.reject('粘贴内容不符合数据验证规则')
          writes.push({ id, raw: result.startsWith('=') ? "'" + result : result })
          continue
        }
        const raw = image ? encodeCellImage(image)
          : payload?.source ? sheet.formulas.shift(value, sheet.sheetId, canonicalRow - payload.source.rows[r], start.column - payload.source.column)
          : sheet.formulas.store(value, sheet.sheetId)
        if (!sheet.features.accepts(key, image ? value : sheet.formulas.source(raw))) return this.host.reject('粘贴内容不符合数据验证规则')
        writes.push({ id, raw, style })
      }
    }
    this.host.resize(end.row + 1, end.column + 1)
    selection.anchor = start
    selection.focus = end
    this.host.stopCapturing()
    sheet.doc.transact(() => {
      for (const { id, raw, style } of writes) {
        if (raw !== undefined) sheet.cells.raw.set(id, raw)
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
