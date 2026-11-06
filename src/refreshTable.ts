import type { Awareness } from 'y-protocols/awareness'
import type { CellFormatting } from './formatting'
import type { TableSelection } from './tableSelection'
import { addCursorLabel, addSelectionOverlay } from './overlays'
import { remoteSelectionRange, selectionRange, type AwarenessSelection } from './selection'
type RefreshView = {
  table: HTMLTableElement
  viewport: HTMLElement
  editingKey?: string
  formatting: CellFormatting
  selection: TableSelection
  awareness: Awareness
  userColor?: string
  rowCount: number
  columnCount: number
  size(axis: 'row' | 'column', index: number): number
}

export function refreshValues(view: RefreshView) {
    const active = document.activeElement
    view.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      const key = cell.dataset.key
      if (key && cell !== active && key !== view.editingKey) {
        const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value')
        if (value) value.textContent = view.formatting.displayValue(key)
        else cell.textContent = view.formatting.displayValue(key)
      }
    })
  }

export function refreshSelection(view: RefreshView) {
    view.viewport.querySelectorAll('.colwork-table__selection').forEach((selection) => selection.remove())
    if (!view.selection.focus) return
    const bounds = view.selection.getSelectionBounds()
    view.table.querySelectorAll<HTMLElement>('th[data-selection-axis]').forEach(header => {
      const axis = header.dataset.selectionAxis
      const index = Number(header.dataset.selectionIndex)
      const selected = view.selection.mode === 'all' || (view.selection.mode === axis && (axis === 'row'
        ? index >= bounds.top && index <= bounds.bottom
        : index >= bounds.left && index <= bounds.right))
      header.classList.toggle('is-selected-header', selected)
    })
    addSelectionOverlay(view.table, selectionRange({ row: bounds.top, column: bounds.left }, { row: bounds.bottom, column: bounds.right }), 'colwork-table__selection', view.userColor ?? '#3b82f6', (axis, index) => axis === 'row' ? view.size('row', index) : view.size('column', index))
  }

export function refreshCursors(view: RefreshView) {
    if (!view.table) return
    view.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      cell.querySelectorAll('.colwork-table__remote-cursor').forEach((cursor) => cursor.remove())
    })
    view.viewport.querySelectorAll('.colwork-table__remote-selection').forEach((selection) => selection.remove())
    view.awareness.getStates().forEach((state, clientId) => {
      if (clientId === view.awareness.clientID) return
      const selectionState = state.selection as AwarenessSelection | undefined
      if (selectionState?.anchor && selectionState.focus) {
        const remoteRange = remoteSelectionRange(selectionState, view.rowCount, view.columnCount)
        if (remoteRange) addSelectionOverlay(view.table, remoteRange, 'colwork-table__remote-selection', state.user?.color ?? '#94a3b8', (axis, index) => axis === 'row' ? view.size('row', index) : view.size('column', index))
        const top = Math.min(selectionState.anchor.row, selectionState.focus.row)
        const left = Math.min(selectionState.anchor.column, selectionState.focus.column)
        const labelCell = view.table.querySelector<HTMLTableCellElement>(`td[data-key="${top}:${left}"]`)
        if (labelCell) addCursorLabel(labelCell, state, clientId)
      } else {
        const cursor = state.cursor as { row: number; column: number } | undefined
        const cursorCell = cursor && view.table.querySelector<HTMLTableCellElement>(`td[data-key="${cursor.row}:${cursor.column}"]`)
        if (cursorCell) addCursorLabel(cursorCell, state, clientId)
      }
    })
  }

export function refreshStyles(view: RefreshView) {
    view.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      if (cell.dataset.key) {
        view.formatting.applyStyle(cell, cell.dataset.key)
        const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value')
        if (value) {
          view.formatting.applyStyle(value, cell.dataset.key)
          value.textContent = view.formatting.displayValue(cell.dataset.key)
        }
      }
    })
    refreshSelection(view)
    refreshCursors(view)
  }

