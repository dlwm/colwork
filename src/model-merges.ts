import type { CellRange } from './range'

/** Sweep rectangles across rows with a range-add tree over compressed columns. */
export function hasOverlappingMerges(merges: CellRange[]) {
  if (merges.length < 2) return false
  const columns = [...new Set(merges.flatMap(range => [range.start.column, range.end.column + 1]))].sort((a, b) => a - b)
  const indices = new Map(columns.map((column, index) => [column, index]))
  const events = merges.flatMap(range => [
    { row: range.start.row, left: indices.get(range.start.column)!, right: indices.get(range.end.column + 1)! - 1, delta: 1 },
    { row: range.end.row + 1, left: indices.get(range.start.column)!, right: indices.get(range.end.column + 1)! - 1, delta: -1 },
  ]).sort((a, b) => a.row - b.row || a.delta - b.delta)
  const maximum = new Int32Array(columns.length * 4)
  const lazy = new Int32Array(columns.length * 4)
  const add = (node: number, left: number, right: number, start: number, end: number, delta: number): void => {
    if (start <= left && right <= end) {
      maximum[node] += delta
      lazy[node] += delta
      return
    }
    const middle = Math.floor((left + right) / 2)
    if (start <= middle) add(node * 2, left, middle, start, end, delta)
    if (end > middle) add(node * 2 + 1, middle + 1, right, start, end, delta)
    maximum[node] = lazy[node] + Math.max(maximum[node * 2], maximum[node * 2 + 1])
  }
  for (const event of events) {
    add(1, 0, columns.length - 2, event.left, event.right, event.delta)
    if (maximum[1] > 1) return true
  }
  return false
}
