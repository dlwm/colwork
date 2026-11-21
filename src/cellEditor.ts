import type { CellPosition } from './range'
import type { EditingState } from './options'

type EditorHost = {
  table: HTMLTableElement
  id(key: string): string | undefined
  position(id: string): string | undefined
  canEdit(key: string): boolean
  read(key: string): string | undefined
  readRaw(id: string): string | undefined
  write(key: string, value: string, previous: string | undefined): void
  applyStyle(element: HTMLElement, key: string): void
  renderContent(element: HTMLElement, key: string): void
  announce(cursor: CellPosition & { offset?: number }): void
  move(vertical: number, horizontal: number): void
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
  private originalRaw?: string
  constructor(private readonly host: EditorHost) {}

  start(cell: HTMLTableCellElement, key: string, announce = true, initial?: string) {
    if (!this.host.canEdit(key) || this.key === key) return
    this.finish(true)
    cell = this.host.table.querySelector<HTMLTableCellElement>(`td[data-key="${key}"]`) ?? cell
    this.id = this.host.id(key)
    if (this.id === undefined) return
    this.original = this.host.read(key) ?? ''
    this.originalRaw = this.host.readRaw(this.id)
    const input = document.createElement('textarea')
    input.className = 'colwork-table__editor'
    input.value = initial ?? this.original
    this.host.applyStyle(input, key)
    this.input = input
    cell.classList.add('is-editing')
    cell.append(input)
    if (announce) this.host.announce({ ...(this.host.focus() ?? { row: 0, column: 0 }), offset: 0 })
    input.addEventListener('input', () => this.host.changed({ editing: true, dirty: input.value !== this.original }))
    this.host.changed({ editing: true, dirty: input.value !== this.original })
    input.addEventListener('blur', () => this.finish(true), { once: true })
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      if ((event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        this.finish(true)
        this.host.move(event.key === 'Enter' ? 1 : 0, event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0)
      }
      if (event.key === 'Escape') { event.stopPropagation(); this.finish(false) }
    })
    input.focus({ preventScroll: true })
    if (initial === undefined) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
  }

  finish(commit: boolean) {
    if (!this.input) return
    const key = this.key
    const input = this.input
    // Clear state before removing a focused textarea, which synchronously fires blur.
    this.input = undefined
    this.id = undefined
    if (key && commit && this.host.canEdit(key) && input.value !== this.original) {
      this.host.write(key, input.value, this.originalRaw)
    }
    this.original = ''
    this.originalRaw = undefined
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
