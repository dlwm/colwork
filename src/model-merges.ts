import type { CellRange } from './range'

export function compareMergeRanges(a: CellRange, b: CellRange) {
  return a.start.row - b.start.row || a.start.column - b.start.column
    || b.end.row - a.end.row || b.end.column - a.end.column
}

export function mergesIntersect(a: CellRange, b: CellRange) {
  return a.start.row <= b.end.row && b.start.row <= a.end.row
    && a.start.column <= b.end.column && b.start.column <= a.end.column
}

/** Keep the first rectangle in coordinate order wherever merged regions conflict. */
export function resolveMergeRanges(merges: CellRange[]): CellRange[] {
  return sweepMerges(merges, false) as CellRange[]
}

export function hasOverlappingMerges(merges: CellRange[]): boolean {
  return sweepMerges(merges, true) as boolean
}

// Sweep rectangles across rows with a range-add tree over compressed columns.
function sweepMerges(merges: CellRange[], detectConflict: boolean): boolean | CellRange[] {
  if (merges.length < 2) return detectConflict ? false : merges
  const columns = [...new Set(merges.flatMap(range => [range.start.column, range.end.column + 1]))].sort((a, b) => a - b)
  const indices = new Map(columns.map((column, index) => [column, index]))
  const events = merges.flatMap(range => [
    { range, row: range.start.row, opening: true },
    { range, row: range.end.row + 1, opening: false },
  ]).sort((a, b) => a.row - b.row || Number(a.opening) - Number(b.opening) || compareMergeRanges(a.range, b.range))
  const accepted = new Set<CellRange>()
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
  for (const { range, opening } of events) {
    const left = indices.get(range.start.column)!
    const right = indices.get(range.end.column + 1)! - 1
    if (!opening) {
      if (accepted.has(range)) add(1, 0, columns.length - 2, left, right, -1)
      continue
    }
    add(1, 0, columns.length - 2, left, right, 1)
    if (maximum[1] <= 1) accepted.add(range)
    else {
      if (detectConflict) return true
      add(1, 0, columns.length - 2, left, right, -1)
    }
  }
  return detectConflict ? false : [...accepted]
}
