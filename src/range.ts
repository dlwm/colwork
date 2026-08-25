export type CellPosition = { row: number; column: number }

export type CellRange = {
  start: CellPosition
  end: CellPosition
}

export function normalizeRange(start: CellPosition, end: CellPosition): CellRange {
  return {
    start: {
      row: Math.min(start.row, end.row),
      column: Math.min(start.column, end.column),
    },
    end: {
      row: Math.max(start.row, end.row),
      column: Math.max(start.column, end.column),
    },
  }
}

export function containsPosition(range: CellRange, position: CellPosition) {
  return position.row >= range.start.row && position.row <= range.end.row
    && position.column >= range.start.column && position.column <= range.end.column
}

export function rangeSize(range: CellRange) {
  return {
    rows: range.end.row - range.start.row + 1,
    columns: range.end.column - range.start.column + 1,
  }
}

export function cellKey(position: CellPosition) {
  return `${position.row}:${position.column}`
}
