import { cellKey, containsPosition, type CellPosition } from './range'
import { selectionRange, type SelectionMode } from './selection'
import type { SheetDocument } from './sheetDocument'
import type { CollaborationSession } from './collaboration'
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
    this.host.session.publish({
      ...fields,
      selection: { anchor: this.anchor, focus: this.focus, mode: this.mode },
    })
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
    this.updateAwareness({ cursor, editing: this.host.editingKey() ?? null })
  }

}
