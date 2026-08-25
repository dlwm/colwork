import { normalizeRange, type CellPosition, type CellRange } from './range'

export type SelectionMode = 'row' | 'column' | 'all'

export type AwarenessSelection = {
  anchor?: CellPosition
  focus?: CellPosition
  mode?: SelectionMode
}

export function selectionRange(anchor?: CellPosition, focus?: CellPosition): CellRange {
  const start = anchor ?? focus ?? { row: 0, column: 0 }
  return normalizeRange(start, focus ?? start)
}

export function selectionFocusForMode(mode: SelectionMode | undefined, focus: CellPosition, rowCount: number, columnCount: number) {
  return {
    row: mode === 'column' || mode === 'all' ? rowCount - 1 : focus.row,
    column: mode === 'row' || mode === 'all' ? columnCount - 1 : focus.column,
  }
}

export function remoteSelectionRange(selection: AwarenessSelection, rowCount: number, columnCount: number) {
  if (!selection.anchor || !selection.focus) return undefined
  return selectionRange(selection.anchor, selectionFocusForMode(selection.mode, selection.focus, rowCount, columnCount))
}
