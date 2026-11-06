import * as Y from 'yjs'
import { cellKey, containsPosition, type CellPosition, type CellRange } from './range'
import { selectionRange } from './selection'
import { getSheetMaps } from './model-validation'
import { parseCellKey, parseMergeKey } from './model-schema'

/** Data operations shared by the view. This service never owns its document's lifetime. */
export class SheetDocument {
  readonly cells: Y.Map<string>
  readonly styles: Y.Map<string>
  readonly rowHeights: Y.Map<number>
  readonly columnWidths: Y.Map<number>
  readonly merges: Y.Map<string>
  readonly locks: Y.Map<string>
  private mergeCache?: CellRange[]
  private readonly onMergesChange = () => { this.mergeCache = undefined }

  constructor(readonly doc: Y.Doc, readonly origin: unknown = null) {
    const maps = getSheetMaps(doc)
    this.cells = maps.cells
    this.styles = maps.styles
    this.rowHeights = maps.rowHeights
    this.columnWidths = maps.columnWidths
    this.merges = maps.merges
    this.locks = maps.locks
    this.merges.observe(this.onMergesChange)
  }

  getContentSize() {
    let rows = 1
    let columns = 1
    for (const key of [...this.cells.keys(), ...this.styles.keys(), ...this.locks.keys()]) {
      const position = parseCellKey(key)
      if (!position) continue
      rows = Math.max(rows, position.row + 1)
      columns = Math.max(columns, position.column + 1)
    }
    for (const range of this.getMergeRanges()) {
      rows = Math.max(rows, range.end.row + 1)
      columns = Math.max(columns, range.end.column + 1)
    }
    for (const key of this.rowHeights.keys()) rows = Math.max(rows, Number(key) + 1 || 1)
    for (const key of this.columnWidths.keys()) columns = Math.max(columns, Number(key) + 1 || 1)
    return { rows, columns }
  }

  hasPartialMerge(axis: 'row' | 'column', start: number, end: number) {
    if (start > end) return false
    return this.getMergeRanges().some(merge => {
      const first = merge.start[axis]
      const last = merge.end[axis]
      return first <= end && last >= start && (first < start || last > end)
    })
  }

  rangeHasLocks(range: CellRange, passwordOnly = false) {
    const locked = (key: string) => this.locks.has(key) && (!passwordOnly || this.locks.get(key) !== '1')
    const area = (range.end.row - range.start.row + 1) * (range.end.column - range.start.column + 1)
    if (area <= this.locks.size) {
      for (let row = range.start.row; row <= range.end.row; row++) {
        for (let column = range.start.column; column <= range.end.column; column++) if (locked(cellKey({ row, column }))) return true
      }
      return false
    }
    for (const key of this.locks.keys()) {
      const position = parseCellKey(key)
      if (position && locked(key) && containsPosition(range, position)) return true
    }
    return false
  }

  isCellLocked(key: string, merge?: CellRange | null) {
    if (this.locks.has(key)) return true
    const position = parseCellKey(key)
    if (merge === undefined && position) merge = this.getMergeRanges().find(range => containsPosition(range, position))
    return !!merge && this.rangeHasLocks(merge)
  }

  isCellPasswordLocked(key: string, merge?: CellRange | null) {
    if (this.locks.has(key) && this.locks.get(key) !== '1') return true
    const position = parseCellKey(key)
    if (merge === undefined && position) merge = this.getMergeRanges().find(range => containsPosition(range, position))
    return !!merge && this.rangeHasLocks(merge, true)
  }

  isAxisLocked(axis: 'row' | 'column', index: number, following = false) {
    return Array.from(this.locks.keys()).some((key) => {
      const coordinate = Number(key.split(':')[axis === 'row' ? 0 : 1])
      return following ? coordinate >= index : coordinate === index
    })
  }

  /** Passwords are optional for legacy/plain locks; protected locks require verification. */

  mergeKey(range: CellRange) {
    return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`
  }

  getMergeRanges() {
    if (this.mergeCache) return this.mergeCache
    const ranges = Array.from(this.merges.keys()).flatMap(key => {
      const range = parseMergeKey(key)
      return range ? [range] : []
    })
    // Reads inside a caller's open transaction must see its in-progress map writes.
    if (this.doc._transaction === null) this.mergeCache = ranges
    return ranges
  }

  destroy() { this.merges.unobserve(this.onMergesChange) }

  expandSelectionToMerges(anchor: CellPosition, focus: CellPosition) {
    let range = selectionRange(anchor, focus)
    for (const merge of this.getMergeRanges()) {
      const intersects = merge.start.row <= range.end.row && merge.end.row >= range.start.row
        && merge.start.column <= range.end.column && merge.end.column >= range.start.column
      if (!intersects) continue
      range = {
        start: { row: Math.min(range.start.row, merge.start.row), column: Math.min(range.start.column, merge.start.column) },
        end: { row: Math.max(range.end.row, merge.end.row), column: Math.max(range.end.column, merge.end.column) },
      }
    }
    const forwardRow = focus.row >= anchor.row
    const forwardColumn = focus.column >= anchor.column
    return {
      anchor: {
        row: forwardRow ? range.start.row : range.end.row,
        column: forwardColumn ? range.start.column : range.end.column,
      },
      focus: {
        row: forwardRow ? range.end.row : range.start.row,
        column: forwardColumn ? range.end.column : range.start.column,
      },
    }
  }

  seed(rows: string[][]) {
    rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      const key = `${rowIndex}:${columnIndex}`
      if (!this.cells.has(key) && !this.isCellLocked(key)) this.cells.set(key, value)
    }))
  }

  modifyAxis(axis: 'row' | 'column', index: number, amount: number, removeCount = 0) {
    const maps = [this.cells, this.styles]
    this.doc.transact(() => {
      maps.forEach((map) => {
        const entries = Array.from(map.entries())
        map.clear()
        entries.forEach(([key, value]) => {
          const [row, column] = key.split(':').map(Number)
          const coordinate = axis === 'row' ? row : column
          if (removeCount && coordinate >= index && coordinate < index + removeCount) return
          const nextCoordinate = coordinate >= index + removeCount ? coordinate + amount : coordinate
          const nextKey = axis === 'row' ? cellKey({ row: nextCoordinate, column }) : cellKey({ row, column: nextCoordinate })
          map.set(nextKey, value)
        })
      })
      const merges = this.getMergeRanges()
      this.merges.clear()
      merges.forEach((range) => {
        const start = axis === 'row' ? range.start.row : range.start.column
        const end = axis === 'row' ? range.end.row : range.end.column
        if (removeCount && start < index + removeCount && end >= index) return
        const shift = start >= index + removeCount ? amount : 0
        const next = axis === 'row'
          ? { start: { row: range.start.row + shift, column: range.start.column }, end: { row: range.end.row + shift, column: range.end.column } }
          : { start: { row: range.start.row, column: range.start.column + shift }, end: { row: range.end.row, column: range.end.column + shift } }
        this.merges.set(this.mergeKey(next), '1')
      })
    }, this.origin)
  }
}
