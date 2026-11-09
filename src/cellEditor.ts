import type { CellPosition } from './range'
import type { EditingState } from './options'
import { normalizeCellText } from './unicode'

type EditorHost = {
  table: HTMLTableElement
  id(key: string): string | undefined
  position(id: string): string | undefined
  canEdit(key: string): boolean
  read(key: string): string | undefined
  write(key: string, value: string): void
  applyStyle(element: HTMLElement, key: string): void
  renderContent(element: HTMLElement, key: string): void
  announce(cursor: CellPosition & { offset?: number }): void
  focus(): CellPosition | undefined
  clearEditingPresence(): void
  refresh(): void
  render(): void
  changed(state: EditingState): void
}

export class CellEditor {
  input?: HTMLTextAreaElement
  private id?: string
  get key() { return this.id === undefined ? undefined : this.host.position(this.id) }
  private original = ''
  constructor(private readonly host: EditorHost) {}

  start(cell: HTMLTableCellElement, key: string, announce = true) {
    if (!this.host.canEdit(key) || this.key === key) return
    this.finish(true)
    cell = this.host.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`) ?? cell
    this.id = this.host.id(key)
    if (this.id === undefined) return
    this.original = this.host.read(key) ?? ''
    const input = document.createElement('textarea')
    input.className = 'colwork-table__editor'
    input.value = this.original
    this.host.applyStyle(input, key)
    this.input = input
    cell.classList.add('is-editing')
    cell.append(input)
    if (announce) this.host.announce({ ...(this.host.focus() ?? { row: 0, column: 0 }), offset: 0 })
    input.addEventListener('input', () => this.host.changed({ editing: true, dirty: input.value !== this.original }))
    this.host.changed({ editing: true, dirty: false })
    input.addEventListener('blur', () => this.finish(true), { once: true })
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) input.blur()
      if (event.key === 'Escape') this.finish(false)
    })
    input.focus()
    input.select()
  }

  finish(commit: boolean) {
    if (!this.input) return
    const key = this.key
    const input = this.input
    // Clear state before removing a focused textarea, which synchronously fires blur.
    this.input = undefined
    this.id = undefined
    if (key && commit && this.host.canEdit(key) && input.value !== this.original && input.value !== this.host.read(key)) {
      this.host.write(key, normalizeCellText(input.value))
    }
    this.original = ''
    this.host.clearEditingPresence()
    input.remove()
    const cell = key && this.host.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`)
    if (!key || !cell) { this.host.render(); this.host.changed({ editing: false, dirty: false }); return }
    this.host.table.querySelectorAll('td.is-editing').forEach(element => element.classList.remove('is-editing'))
    const value = cell.querySelector<HTMLElement>('.colwork-table__cell-value') ?? document.createElement('span')
    value.className = 'colwork-table__cell-value'
    this.host.renderContent(value, key)
    if (!value.parentElement) cell.append(value)
    Array.from(cell.childNodes).forEach(node => {
      if (node !== value && node.nodeType === Node.TEXT_NODE) node.remove()
    })
    this.host.applyStyle(cell, key)
    this.host.applyStyle(value, key)
    this.host.refresh()
    this.host.changed({ editing: false, dirty: false })
  }
}
