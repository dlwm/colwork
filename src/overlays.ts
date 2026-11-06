import { colorWithAlpha } from './color'
import type { CellRange } from './range'
import { getViewportOffset } from './viewport'
type AxisSize = (axis: 'row' | 'column', index: number) => number

export function addSelectionOverlay(table: HTMLTableElement, range: CellRange, className: string, color: string, axisSize: AxisSize) {
  // Attach highlights to the actual rendered cells. Their containing blocks
  // provide exact merged/resized geometry and native sticky scrolling without
  // waiting for the virtual window's next animation frame.
  table.querySelectorAll<HTMLTableCellElement>('td[data-key]').forEach(cell => {
    const [sourceRow, sourceColumn] = cell.dataset.key!.split(':').map(Number)
    const row = Number(cell.dataset.renderRow ?? sourceRow)
    const column = Number(cell.dataset.renderColumn ?? sourceColumn)
    const bottom = Number(cell.dataset.renderBottom ?? row + cell.rowSpan - 1)
    const right = Number(cell.dataset.renderRight ?? column + cell.colSpan - 1)
    if (row > range.end.row || bottom < range.start.row || column > range.end.column || right < range.start.column) return
    const border = getComputedStyle(cell)
    const topBorder = parseFloat(border.borderTopWidth)
    const rightBorder = parseFloat(border.borderRightWidth)
    const bottomBorder = parseFloat(border.borderBottomWidth)
    const leftBorder = parseFloat(border.borderLeftWidth)
    const inset = (start: number, end: number, selectedStart: number, selectedEnd: number, axis: 'row' | 'column', leadingBorder: number, trailingBorder: number) => {
      // Header selection may intentionally include only part of a merge.
      // Use rendered header sizes to locate that part within the merged cell.
      if (start >= selectedStart && end <= selectedEnd) return [`${-leadingBorder}px`, `${-trailingBorder}px`]
      let total = 0, leading = 0, trailing = 0
      for (let index = start; index <= end; index++) {
        const header = table.querySelector<HTMLElement>(`th[data-selection-axis="${axis}"][data-selection-index="${index}"]`)
        const box = header?.getBoundingClientRect()
        const size = axis === 'row' ? box?.height ?? axisSize('row', index) : box?.width ?? axisSize('column', index)
        total += size
        if (index < selectedStart) leading += size
        if (index > selectedEnd) trailing += size
      }
      const offset = (size: number, edge: number) => size === 0 ? `${-edge}px`
        : `calc(${size / total * 100}% + ${(leadingBorder + trailingBorder) * size / total - edge}px)`
      return [offset(leading, leadingBorder), offset(trailing, trailingBorder)]
    }
    const [top, bottomInset] = inset(row, bottom, range.start.row, range.end.row, 'row', topBorder, bottomBorder)
    const [left, rightInset] = inset(column, right, range.start.column, range.end.column, 'column', leftBorder, rightBorder)
    const overlay = document.createElement('span')
    overlay.className = className
    overlay.setAttribute('aria-hidden', 'true')
    // Absolute children are positioned against the padding box. Include each
    // cell's real borders so the outside edge coincides with its border box.
    Object.assign(overlay.style, {
      top, right: rightInset, bottom: bottomInset, left,
      borderTopWidth: row <= range.start.row ? '2px' : '0',
      borderRightWidth: right >= range.end.column ? '2px' : '0',
      borderBottomWidth: bottom >= range.end.row ? '2px' : '0',
      borderLeftWidth: column <= range.start.column ? '2px' : '0',
      borderColor: color,
      backgroundColor: colorWithAlpha(color, 0.1),
    })
    cell.append(overlay)
  })

}

export function addCursorLabel(cell: HTMLTableCellElement, state: { user?: { name?: string; color?: string } }, clientId: number) {
  const marker = document.createElement('span')
  marker.className = 'colwork-table__remote-cursor'
  marker.style.backgroundColor = state.user?.color ?? '#64748b'
  marker.textContent = state.user?.name ?? String(clientId).slice(0, 6)
  cell.append(marker)
  }

export function refreshFrozenBoundaries(layer: HTMLElement, viewport: HTMLElement, rows: number, columns: number, headerWidth: number, headerHeight: number, axisSize: AxisSize) {
  // The layer shares the viewport's grid area but sits outside its scrolling
  // contents. Browser scrolling never changes its position, even before JS runs.
  layer.replaceChildren()
  layer.style.width = `${viewport.clientWidth}px`
  layer.style.height = `${viewport.clientHeight}px`
  const add = (axis: 'row' | 'column', count: number, position: number, limit: number) => {
    if (!count || position >= limit) return
    const line = document.createElement('span')
    line.className = `colwork-table__frozen-boundary colwork-table__frozen-boundary--${axis}`
    line.setAttribute('aria-hidden', 'true')
    line.style.left = `${axis === 'column' ? position - 1 : 0}px`
    line.style.top = `${axis === 'row' ? position - 1 : 0}px`
    if (axis === 'column') line.style.height = `${viewport.clientHeight}px`
    else line.style.width = `${viewport.clientWidth}px`
    layer.append(line)
  }
  add('row', rows, headerHeight + getViewportOffset(rows, row => axisSize('row', row)), viewport.clientHeight)
  add('column', columns, headerWidth + getViewportOffset(columns, column => axisSize('column', column)), viewport.clientWidth)

}
