export type ViewportRange = {
  top: number
  bottom: number
  left: number
  right: number
}

export type ViewportSize = (index: number) => number

type ViewportOptions = {
  scrollTop: number
  scrollLeft: number
  clientHeight: number
  clientWidth: number
  rowCount: number
  columnCount: number
  rowSize: ViewportSize
  columnSize: ViewportSize
  overscan: number
}

export function getViewportOffset(index: number, size: ViewportSize) {
  let offset = 0
  for (let current = 0; current < index; current += 1) offset += size(current)
  return offset
}

export function getViewportTotalSize(count: number, size: ViewportSize) {
  return getViewportOffset(count, size)
}

export function getViewportRange(options: ViewportOptions): ViewportRange {
  const findRange = (offset: number, viewportSize: number, count: number, size: ViewportSize) => {
    let position = 0
    let first = 0
    while (first < count && position + size(first) <= offset) {
      position += size(first)
      first += 1
    }
    const start = Math.max(0, first - options.overscan)
    let end = first
    let visiblePosition = position
    while (end < count && visiblePosition < offset + viewportSize) {
      visiblePosition += size(end)
      end += 1
    }
    return { start, end: Math.min(count - 1, end + options.overscan - 1) }
  }
  const rows = findRange(options.scrollTop, options.clientHeight, options.rowCount, options.rowSize)
  const columns = findRange(options.scrollLeft, options.clientWidth, options.columnCount, options.columnSize)
  const top = rows.start
  const bottom = rows.end
  const left = columns.start
  const right = columns.end
  return { top, bottom, left, right }
}
