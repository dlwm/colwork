import type { Awareness } from 'y-protocols/awareness'
import type { TableSelection } from './tableSelection'
import { addCursorLabel, addSelectionOverlay } from './overlays'
import { remoteSelectionRange, selectionRange, type AwarenessPosition, type AwarenessSelection } from './selection'
import type { SheetDocument } from './sheetDocument'
import { MAIN_SHEET_ID } from './workbookModel'
type RefreshView = {
  table: HTMLTableElement
  viewport: HTMLElement
  editingKey?: string
  applyStyle(element: HTMLElement, key: string): void
  selection: TableSelection
  awareness: Awareness
  sheet: SheetDocument
  renderContent(element: HTMLElement, key: string): void
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
        view.renderContent(value ?? cell, key)
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
      if (clientId === view.awareness.clientID || (state.sheetId ?? MAIN_SHEET_ID) !== view.sheet.sheetId) return
      const coordinates = view.sheet.coordinates
      const position = (target?: AwarenessPosition) => {
        if (!target || !Number.isSafeInteger(target.row) || !Number.isSafeInteger(target.column) || target.row < 0 || target.column < 0) return undefined
        const row = typeof target.rowId === 'string' ? coordinates.axisPosition('row', target.rowId) : coordinates.visualRow(target.row)
        const column = typeof target.columnId === 'string' ? coordinates.axisPosition('column', target.columnId) : target.column
        return row === undefined || column === undefined ? undefined : { row, column }
      }
      const remote = state.selection as AwarenessSelection | undefined
      const cursor = position(state.cursor)
      const selectionState = remote && { ...remote, anchor: position(remote.anchor), focus: position(remote.focus) }
      if (view.sheet.coordinates.hasRowOrder) {
        const target = cursor ?? selectionState?.focus
        if (target) {
          const cell = view.table.querySelector<HTMLTableCellElement>(`td[data-key="${target.row}:${target.column}"]`)
          if (cell) addCursorLabel(cell, state, clientId)
        }
        return
      }
      if (selectionState?.anchor && selectionState.focus) {
        const remoteRange = remoteSelectionRange(selectionState, view.rowCount, view.columnCount)
        if (remoteRange) addSelectionOverlay(view.table, remoteRange, 'colwork-table__remote-selection', state.user?.color ?? '#94a3b8', (axis, index) => axis === 'row' ? view.size('row', index) : view.size('column', index))
        const top = Math.min(selectionState.anchor.row, selectionState.focus.row)
        const left = Math.min(selectionState.anchor.column, selectionState.focus.column)
        const labelCell = view.table.querySelector<HTMLTableCellElement>(`td[data-key="${top}:${left}"]`)
        if (labelCell) addCursorLabel(labelCell, state, clientId)
      } else {
        const cursorCell = cursor && view.table.querySelector<HTMLTableCellElement>(`td[data-key="${cursor.row}:${cursor.column}"]`)
        if (cursorCell) addCursorLabel(cursorCell, state, clientId)
      }
    })
  }

export function refreshStyles(view: RefreshView) {
    view.table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach((cell) => {
      if (cell.dataset.key) {
        view.applyStyle(cell, cell.dataset.key)
        const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value')
        if (value) {
          view.applyStyle(value, cell.dataset.key)
          view.renderContent(value, cell.dataset.key)
        }
      }
    })
    refreshSelection(view)
    refreshCursors(view)
  }

