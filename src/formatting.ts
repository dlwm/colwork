import type * as Y from 'yjs'
import { cellKey } from './range'
import { isCellStyle } from './model-validation'
import type { CellBorder, CellStyle } from './model-schema'
import type { ProjectedMap } from './sheetCoordinates'
export type BooleanStyleKey = 'bold' | 'italic' | 'underline' | 'strike' | 'wrap'
export type BorderMode = 'outer' | 'inner' | 'horizontal' | 'vertical'
type FormatHost = {
  origin: unknown
  zoom(): number
  canEdit(): boolean
  selectedKey(): string | undefined
  readValue(key: string): string
  bounds(): { top: number; bottom: number; left: number; right: number }
  render(): void
}

export class CellFormatting {
  constructor(private readonly doc: Y.Doc, private readonly styles: ProjectedMap<string>, private readonly host: FormatHost) {}

  readStyle(key: string): CellStyle {
    try {
      const value: unknown = JSON.parse(this.styles.get(key) ?? '{}')
      return isCellStyle(value) ? value : {}
    } catch {
      return {}
    }
  }

  applyStyle(element: HTMLElement, key: string) {
    const style = this.readStyle(key)
    element.style.fontWeight = style.bold ? '700' : ''
    element.style.fontStyle = style.italic ? 'oblique' : ''
    element.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    element.style.transform = element.classList.contains('colwork-table__cell-value') && style.italic ? 'skewX(-8deg)' : ''
    element.style.fontSize = style.fontSize ? `${style.fontSize * this.host.zoom()}px` : ''
    element.style.color = style.color ?? ''
    element.style.backgroundColor = style.background ?? ''
    element.style.textAlign = style.align ?? ''
    if (element.classList.contains('colwork-table__cell-value')) element.style.whiteSpace = style.wrap ? 'pre-wrap' : 'pre'
    if (!element.classList.contains('colwork-table__cell-value') && !element.classList.contains('colwork-table__editor')) {
      element.style.borderTop = style.border?.top ? '2px solid #64748b' : ''
      element.style.borderRight = style.border?.right ? '2px solid #64748b' : ''
      element.style.borderBottom = style.border?.bottom ? '2px solid #64748b' : ''
      element.style.borderLeft = style.border?.left ? '2px solid #64748b' : ''
    }
  }

  displayValue(key: string) {
    const value = this.host.readValue(key)
    const format = this.readStyle(key).format ?? 'general'
    if (!value || format === 'general') return value
    if (format === 'number') {
      const number = Number(value)
      return Number.isFinite(number) ? number.toLocaleString() : value
    }
    if (format === 'percent') {
      const number = Number(value.replace(/%$/, ''))
      return Number.isFinite(number) ? `${value.endsWith('%') ? number : number * 100}%` : value
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10)
  }

  toggleFormat(format: BooleanStyleKey) {
    if (!this.host.canEdit() || !this.host.selectedKey()) return
    const { top, bottom, left, right } = this.host.bounds()
    const current = this.readStyle(this.host.selectedKey()!)[format]
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = `${row}:${column}`
          const style = this.readStyle(key)
          style[format] = current ? false : true
          this.styles.set(key, JSON.stringify(style))
        }
      }
    }, this.host.origin)
    this.host.render()
  }

  clearFormatting() {
    if (!this.host.canEdit() || !this.host.selectedKey()) return
    const { top, bottom, left, right } = this.host.bounds()
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) this.styles.delete(cellKey({ row, column }))
      }
    }, this.host.origin)
    this.host.render()
  }

  toggleBorder(mode: BorderMode) {
    if (!this.host.canEdit() || !this.host.selectedKey()) return
    const { top, bottom, left, right } = this.host.bounds()
    const sides = (row: number, column: number): Array<keyof CellBorder> => {
      const result: Array<keyof CellBorder> = []
      if (mode === 'outer') {
        if (row === top) result.push('top')
        if (row === bottom) result.push('bottom')
        if (column === left) result.push('left')
        if (column === right) result.push('right')
      }
      if (mode === 'inner' || mode === 'horizontal') if (row < bottom) result.push('bottom')
      if (mode === 'inner' || mode === 'vertical') if (column < right) result.push('right')
      return result
    }
    const targetCells = Array.from({ length: bottom - top + 1 }, (_, rowOffset) => Array.from({ length: right - left + 1 }, (_, columnOffset) => ({
      row: top + rowOffset,
      column: left + columnOffset,
    }))).flat()
    const targetSides = targetCells.flatMap(({ row, column }) => sides(row, column))
    if (!targetSides.length) return
    const enabled = !targetCells.every(({ row, column }) => sides(row, column).every((side) => this.readStyle(cellKey({ row, column })).border?.[side]))
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = cellKey({ row, column })
          const style = this.readStyle(key)
          const border = { ...(style.border ?? {}) }
          sides(row, column).forEach((side) => {
            if (enabled) border[side] = true
           else delete border[side]
          })
          if (Object.keys(border).length) style.border = border
          else delete style.border
          this.styles.set(key, JSON.stringify(style))
        }
      }
    }, this.host.origin)
    this.host.render()
  }

  setStyle(format: 'color' | 'background' | 'align' | 'fontSize' | 'format', value: string | number | CellStyle['align'] | CellStyle['format']) {
    if (!this.host.canEdit() || !this.host.selectedKey()) return
    const { top, bottom, left, right } = this.host.bounds()
    this.doc.transact(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = `${row}:${column}`
          const style = this.readStyle(key)
          if (format === 'align') style.align = value as CellStyle['align']
          else if (format === 'color') style.color = value as string
          else if (format === 'background') style.background = value as string
          else if (format === 'fontSize') style.fontSize = value as number
          else style.format = value as CellStyle['format']
          this.styles.set(key, JSON.stringify(style))
        }
      }
    }, this.host.origin)
    this.host.render()
  }

}
