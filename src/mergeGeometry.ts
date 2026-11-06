import { cellKey, type CellPosition, type CellRange } from './range'
import type { ViewportRange } from './viewport'

export type MergeFragment = CellRange & { source: CellRange }

/** Index only the rendered fragments, so a large logical merge never expands the DOM window. */
export function indexVisibleMerges(merges: CellRange[], view: ViewportRange, frozenRows: number, frozenColumns: number) {
  const fragments = new Map<string, MergeFragment>()
  const axisSegments = (start: number, end: number, fixed: number, first: number, last: number) => {
    const segments: Array<[number, number]> = []
    if (fixed > 0 && start < fixed) segments.push([start, Math.min(end, fixed - 1)])
    const visibleStart = Math.max(start, fixed, first)
    const visibleEnd = Math.min(end, last)
    if (visibleStart <= visibleEnd) segments.push([visibleStart, visibleEnd])
    return segments
  }
  for (const source of merges) {
    const rows = axisSegments(source.start.row, source.end.row, frozenRows, view.top, view.bottom)
    const columns = axisSegments(source.start.column, source.end.column, frozenColumns, view.left, view.right)
    for (const [top, bottom] of rows) {
      for (const [left, right] of columns) {
        const fragment: MergeFragment = { source, start: { row: top, column: left }, end: { row: bottom, column: right } }
        for (let row = top; row <= bottom; row++) {
          for (let column = left; column <= right; column++) fragments.set(cellKey({ row, column }), fragment)
        }
      }
    }
  }
  return fragments
}

export function isFragmentStart(fragment: MergeFragment, position: CellPosition) {
  return fragment.start.row === position.row && fragment.start.column === position.column
}
