import { cellKey } from './range'
import type { CellRange, CellPosition } from './range'
import { getViewportOffset, getViewportRange, getViewportTotalSize } from './viewport'
import { indexVisibleMerges, isFragmentStart } from './mergeGeometry'
import { HEADER_FONT_SIZE } from './tableConstants'

type RenderView = {
  table: HTMLTableElement
  viewport: HTMLElement
  rowCount: number
  columnCount: number
  frozenRows: number
  frozenColumns: number
  zoomRatio: number
  rowHeaderWidth: number
  columnHeaderHeight: number
  bandedRows: boolean
  showGridLines: boolean
  readOnly: boolean
  getRowHeight(row: number): number
  rowLabel(row: number): string
  getColumnWidth(column: number): number
  getMergeRanges(): CellRange[]
  isCellLocked(key: string, merge: CellRange | null): boolean
  isCellPasswordLocked(key: string, merge: CellRange | null): boolean
  renderContent(element: HTMLElement, key: string): void
  applyStyle(element: HTMLElement, key: string): void
  addResizeHandle(element: HTMLElement, axis: 'row' | 'column', index: number): void
  addHeaderSelection(element: HTMLElement, axis: 'row' | 'column', index: number): void
  selectRange(anchor: CellPosition, focus: CellPosition, mode: 'all'): void
  attachCellListeners(cell: HTMLTableCellElement, key: string, row: number, column: number): void
}

function columnLetter(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function renderTable(state: RenderView) {
  const { rowCount, columnCount } = state
  const rowSize = (row: number) => state.getRowHeight(row)
  const columnSize = (column: number) => state.getColumnWidth(column)
  const view = getViewportRange({
    scrollTop: state.viewport.scrollTop,
    scrollLeft: state.viewport.scrollLeft,
    clientHeight: state.viewport.clientHeight || 560,
    clientWidth: state.viewport.clientWidth || 900,
    rowCount,
    columnCount,
    rowSize,
    columnSize,
    overscan: 4,
  })
  const fragments = indexVisibleMerges(state.getMergeRanges(), view, state.frozenRows, state.frozenColumns)
  view.bottom = Math.max(view.bottom, state.frozenRows - 1)
  view.right = Math.max(view.right, state.frozenColumns - 1)
  const rowStart = Math.max(state.frozenRows, view.top)
  const columnStart = Math.max(state.frozenColumns, view.left)
  const indices = (fixed: number, start: number, end: number) => [
    ...Array.from({ length: fixed }, (_, index) => index),
    -1, // spacer between the frozen prefix and the virtual window
    ...Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index),
  ]
  const rows = indices(state.frozenRows, rowStart, view.bottom)
  const columns = indices(state.frozenColumns, columnStart, view.right)
  const gapWidth = getViewportOffset(columnStart, columnSize) - getViewportOffset(state.frozenColumns, columnSize)
  const gapHeight = getViewportOffset(rowStart, rowSize) - getViewportOffset(state.frozenRows, rowSize)
  const pin = (element: HTMLElement, row: number, column: number) => {
    const top = row >= 0 && row < state.frozenRows
    const left = column >= 0 && column < state.frozenColumns
    if (!top && !left) return
    element.classList.add('is-frozen')
    element.style.position = 'sticky'
    if (top) element.style.top = `${state.columnHeaderHeight + getViewportOffset(row, rowSize)}px`
    if (left) element.style.left = `${state.rowHeaderWidth + getViewportOffset(column, columnSize)}px`
    element.style.zIndex = String(row < 0 ? 10 : column < 0 ? 8 : top && left ? 5 : top ? 4 : 3)
  }
  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')
  const corner = document.createElement('th')
  corner.style.width = `${state.rowHeaderWidth}px`
  corner.style.height = `${state.columnHeaderHeight}px`
  corner.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    state.selectRange({ row: 0, column: 0 }, { row: rowCount - 1, column: columnCount - 1 }, 'all')
  })
  headerRow.append(corner)
  const columnSpacer = (width: number) => {
    const th = document.createElement('th')
    th.style.width = `${width}px`
    th.style.padding = '0'
    th.style.border = '0'
    return th
  }
  for (const index of columns) {
    if (index === -1) { headerRow.append(columnSpacer(gapWidth)); continue }
    const th = document.createElement('th')
    th.style.width = `${columnSize(index)}px`
    th.style.height = `${state.columnHeaderHeight}px`
    th.style.fontSize = `${HEADER_FONT_SIZE * state.zoomRatio}px`
    const letter = document.createElement('b')
    letter.className = 'colwork-table__column-letter'
    letter.textContent = columnLetter(index)
    th.append(letter)
    state.addResizeHandle(th, 'column', index)
    state.addHeaderSelection(th, 'column', index)
    pin(th, -1, index)
    headerRow.append(th)
  }
  headerRow.append(columnSpacer(getViewportTotalSize(columnCount, columnSize) - getViewportOffset(view.right + 1, columnSize)))
  thead.append(headerRow)
  const tbody = document.createElement('tbody')
  const spacer = (height: number) => {
    const tr = document.createElement('tr')
    tr.className = 'colwork-table__spacer'
    tr.style.height = `${height}px`
    const td = document.createElement('td')
    td.colSpan = columns.length + 2
    td.style.height = `${height}px`
    tr.append(td)
    return tr
  }
  for (const row of rows) {
    if (row === -1) { tbody.append(spacer(gapHeight)); continue }
    const tr = document.createElement('tr')
    if (state.bandedRows && row % 2 === 1) tr.className = 'is-banded-row'
    tr.style.height = `${rowSize(row)}px`
    const number = document.createElement('th')
    number.style.width = `${state.rowHeaderWidth}px`
    number.style.height = `${rowSize(row)}px`
    number.style.fontSize = `${HEADER_FONT_SIZE * state.zoomRatio}px`
    number.textContent = state.rowLabel(row)
    state.addResizeHandle(number, 'row', row)
    state.addHeaderSelection(number, 'row', row)
    tr.append(number)
    pin(number, row, -1)
    for (const column of columns) {
      if (column === -1) {
        const leading = document.createElement('td')
        leading.style.width = `${gapWidth}px`
        leading.style.padding = '0'
        leading.style.border = '0'
        tr.append(leading)
        continue
      }
      const fragment = fragments.get(cellKey({ row, column }))
      if (fragment && !isFragmentStart(fragment, { row, column })) continue
      const source = fragment?.source.start ?? { row, column }
      const key = cellKey(source)
      const td = document.createElement('td')
      td.style.width = `${columnSize(column)}px`
      td.style.height = `${rowSize(row)}px`
      td.dataset.key = key
      if (fragment) {
        td.rowSpan = fragment.end.row - fragment.start.row + 1
        td.colSpan = fragment.end.column - fragment.start.column + 1
        td.dataset.renderRow = String(fragment.start.row)
        td.dataset.renderColumn = String(fragment.start.column)
        td.dataset.renderBottom = String(fragment.end.row)
        td.dataset.renderRight = String(fragment.end.column)
      }
      const value = document.createElement('span')
      value.className = 'colwork-table__cell-value'
      value.style.height = `${Math.max(0, rowSize(row) - 4)}px`
      value.style.maxHeight = `${Math.max(0, rowSize(row) - 4)}px`
      state.renderContent(value, key)
      state.applyStyle(value, key)
      td.append(value)
      state.applyStyle(td, key)
      pin(td, row, column)
      const locked = state.isCellLocked(key, fragment?.source ?? null)
      td.classList.toggle('is-locked', locked)
      td.classList.toggle('is-password-locked', state.isCellPasswordLocked(key, fragment?.source ?? null))
      td.setAttribute('aria-readonly', String(state.readOnly || locked))
      if (locked) td.title = state.isCellPasswordLocked(key, fragment?.source ?? null) ? '密码锁定：验证密码后可编辑' : '已锁定：解锁后可编辑'
      state.attachCellListeners(td, key, source.row, source.column)
      tr.append(td)
    }
    const trailing = document.createElement('td')
    trailing.style.width = `${getViewportTotalSize(columnCount, columnSize) - getViewportOffset(view.right + 1, columnSize)}px`
    trailing.style.padding = '0'
    trailing.style.border = '0'
    tr.append(trailing)
    tbody.append(tr)
  }
  tbody.append(spacer(getViewportTotalSize(rowCount, rowSize) - getViewportOffset(view.bottom + 1, rowSize)))
  state.table.style.setProperty('--colwork-zoom', String(state.zoomRatio))
  state.table.style.width = `${state.rowHeaderWidth + getViewportTotalSize(columnCount, columnSize)}px`
  state.table.classList.toggle('is-grid-hidden', !state.showGridLines)
  state.table.classList.toggle('is-banded-rows', state.bandedRows)
  state.table.style.fontSize = `${state.zoomRatio}em`
  state.table.replaceChildren(thead, tbody)


}
