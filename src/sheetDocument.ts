import * as Y from 'yjs'
import { cellKey, containsPosition, type CellPosition, type CellRange } from './range'
import { selectionRange } from './selection'
import { getSheetMaps } from './model-validation'
import { parseCellKey, parseMergeKey } from './model-schema'
import { SheetCoordinates, type ProjectedMap, type SheetAxis } from './sheetCoordinates'
import { FormulaBook } from './formulas'
import { MAIN_SHEET_ID } from './workbookModel'
import type { ColworkRowView } from './options'
import { imageLabel, readCellImage } from './cellImage'

const rowCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Data operations shared by the view. This service never owns its document's lifetime. */
export class SheetDocument {
  readonly cells: ProjectedMap<string>
  readonly styles: ProjectedMap<string>
  readonly rowHeights: ProjectedMap<number>
  readonly columnWidths: ProjectedMap<number>
  readonly merges: ProjectedMap<string>
  readonly locks: ProjectedMap<string>
  readonly coordinates: SheetCoordinates
  readonly formulas: FormulaBook
  private mergeCache?: CellRange[]
  private readonly onMergesChange = () => { this.mergeCache = undefined }
  private readonly beforeObservers = (transaction: Y.Transaction) => {
    if (transaction.changed.size) this.formulas.reset()
    const { row, column } = this.coordinates.edits
    if (!transaction.changed.has(row) && !transaction.changed.has(column)) return
    this.coordinates.invalidate()
    this.mergeCache = undefined
  }

  constructor(readonly doc: Y.Doc, readonly origin: unknown = null, readonly sheetId = MAIN_SHEET_ID) {
    this.coordinates = new SheetCoordinates(doc, sheetId)
    this.formulas = new FormulaBook(doc)
    const maps = this.coordinates.project(getSheetMaps(doc, sheetId))
    this.cells = maps.cells
    this.styles = maps.styles
    this.rowHeights = maps.rowHeights
    this.columnWidths = maps.columnWidths
    this.merges = maps.merges
    this.locks = maps.locks
    this.merges.raw.observe(this.onMergesChange)
    doc.on('beforeObserverCalls', this.beforeObservers)
  }

  readCell(key: string) {
    const value = this.cells.get(key) ?? ''
    return readCellImage(value) ? '' : this.formulas.source(value)
  }

  displayCell(key: string) {
    const id = this.coordinates.cellId(key)
    if (!id) return ''
    const raw = this.cells.raw.get(id) ?? ''
    const image = readCellImage(raw)
    return image ? imageLabel(image) : this.formulas.display(this.sheetId, id, raw)
  }

  writeCell(key: string, value: string) { this.cells.set(key, this.formulas.store(value, this.sheetId)) }

  canonicalKey(id: string) {
    const [rowId, columnId] = id.split(':')
    const { row, column } = this.coordinates.axes
    const r = row.positionOf(rowId), c = column.positionOf(columnId)
    return r === undefined || c === undefined ? undefined : `${r}:${c}`
  }

  applyRowView(view: ColworkRowView) {
    this.coordinates.setRowOrder(undefined)
    this.mergeCache = undefined
    const filters = (view.filters ?? []).map(filter => ({ ...filter, contains: filter.contains.toLowerCase() }))
    if (!view.sort && !filters.length) return
    if (this.getMergeRanges().some(range => range.start.row !== range.end.row)) throw new Error('跨行合并的工作表暂不支持排序筛选')
    const extent = this.getContentSize().rows
    if (extent > 100000) throw new RangeError('排序筛选最多处理十万行')
    const header = Math.min(extent, view.headerRows ?? 0)
    const rows = Array.from({ length: extent - header }, (_, index) => index + header).filter(row =>
      filters.every(filter => this.displayCell(`${row}:${filter.column}`).toLowerCase().includes(filter.contains)))
    if (view.sort) {
      const { column, direction } = view.sort
      const values = new Map(rows.map(row => [row, this.displayCell(`${row}:${column}`)]))
      rows.sort((a, b) => {
        const left = values.get(a)!, right = values.get(b)!
        if (!left || !right) return Number(!left) - Number(!right)
        const numeric = left.trim() && right.trim() && Number.isFinite(Number(left)) && Number.isFinite(Number(right))
        const compare = numeric ? Number(left) - Number(right) : rowCollator.compare(left, right)
        return compare * (direction === 'asc' ? 1 : -1) || a - b
      })
    }
    this.coordinates.setRowOrder([...Array.from({ length: header }, (_, index) => index), ...rows], extent, filters.length > 0)
    this.mergeCache = undefined
  }

  getContentSize() {
    let rows = this.coordinates.extent('row')
    let columns = this.coordinates.extent('column')
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

  destroy() {
    this.merges.raw.unobserve(this.onMergesChange)
    this.doc.off('beforeObserverCalls', this.beforeObservers)
  }

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

  modifyAxis(axis: SheetAxis, index: number, amount: number, removeCount = 0) {
    this.doc.transact(() => {
      if (removeCount) {
        const end = index + removeCount
        for (const map of [this.cells, this.styles]) {
          for (const key of map.keys()) {
            const position = parseCellKey(key)
            if (position && position[axis] >= index && position[axis] < end) map.delete(key)
          }
        }
        const sizes = axis === 'row' ? this.rowHeights : this.columnWidths
        for (let position = index; position < end; position++) sizes.delete(String(position))
        for (const range of this.getMergeRanges()) {
          if (range.start[axis] < end && range.end[axis] >= index) this.merges.delete(this.mergeKey(range))
        }
        this.coordinates.remove(axis, index, removeCount)
      } else {
        this.coordinates.insert(axis, index, amount)
      }
      this.mergeCache = undefined
    }, this.origin)
  }
}
