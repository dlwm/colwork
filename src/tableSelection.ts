import { cellKey, containsPosition, type CellPosition } from './range'
import { selectionRange, type SelectionMode } from './selection'
import type { SheetDocument } from './sheetDocument'
import type { CollaborationSession } from './collaboration'
import { MAIN_SHEET_ID } from './workbookModel'
type SelectionHost = {
  sheet: SheetDocument
  session: CollaborationSession
  dimensions(): { rows: number; columns: number }
  editingKey(): string | undefined
  refresh(): void
}

export class TableSelection {
  anchor?: CellPosition
  focus?: CellPosition
  mode?: SelectionMode
  selectedKey?: string
  pendingCursor?: CellPosition & { offset?: number }
  constructor(private readonly host: SelectionHost) {}

  selectRange(anchor: CellPosition, focus: CellPosition, mode?: 'row' | 'column' | 'all') {
    this.anchor = anchor
    this.focus = focus
    this.mode = mode
    this.selectedKey = cellKey(anchor)
    this.pendingCursor = focus
    this.host.refresh()
  }

  selectHeaderRange(axis: 'row' | 'column', index: number, extend: boolean) {
    let anchor = index
    if (extend && this.mode === axis) {
      anchor = axis === 'row' ? this.anchor?.row ?? index : this.anchor?.column ?? index
    }
    this.selectHeaderSpan(axis, anchor, index)
  }

  selectHeaderSpan(axis: 'row' | 'column', anchor: number, index: number) {
    if (axis === 'row') {
      this.selectRange({ row: anchor, column: 0 }, { row: index, column: this.host.dimensions().columns - 1 }, 'row')
    } else {
      this.selectRange({ row: 0, column: anchor }, { row: this.host.dimensions().rows - 1, column: index }, 'column')
    }
  }

  publishSelection() {
    this.updateAwareness()
  }

  updateAwareness(fields: Record<string, unknown> = {}) {
    const { sheet } = this.host
    this.host.session.publish({
      ...fields,
      ...(sheet.sheetId !== MAIN_SHEET_ID ? { sheetId: sheet.sheetId } : {}),
      selection: { anchor: this.canonical(this.anchor), focus: this.canonical(this.focus), mode: this.mode },
    })
  }

  private canonical<T extends CellPosition>(position?: T) {
    if (!position) return undefined
    const coordinates = this.host.sheet.coordinates
    const row = coordinates.canonicalRow(position.row)
    if (row === undefined) return undefined
    const stable = coordinates.hasRowOrder || coordinates.edits.row.length || coordinates.edits.column.length
    return stable ? { ...position, row, rowId: coordinates.axisId('row', position.row), columnId: coordinates.axisId('column', position.column) }
      : { ...position, row }
  }

  getSelectionBounds() {
    const anchor = this.anchor ?? this.focus ?? { row: 0, column: 0 }
    const focus = this.focus ?? anchor
    const range = selectionRange(anchor, focus)
    return { top: range.start.row, bottom: range.end.row, left: range.start.column, right: range.end.column }
  }

  selectCell(row: number, column: number, extend = false) {
    const position = { row, column }
    this.mode = undefined
    if (!extend || !this.anchor) this.anchor = position
    const expanded = this.host.sheet.expandSelectionToMerges(this.anchor, position)
    this.anchor = expanded.anchor
    this.focus = expanded.focus
    this.selectedKey = `${row}:${column}`
    this.pendingCursor = position
  }

  isPositionSelected(position: CellPosition) {
    return containsPosition(selectionRange(this.anchor, this.focus), position)
  }

  sendAwareness(cursor: CellPosition & { offset?: number }) {
    this.pendingCursor = undefined
    const editing = this.host.editingKey()
    const editingId = editing && this.host.sheet.coordinates.cellId(editing)
    this.updateAwareness({ cursor: this.canonical(cursor), editing: editingId ? this.host.sheet.canonicalKey(editingId) ?? null : null })
  }

}
