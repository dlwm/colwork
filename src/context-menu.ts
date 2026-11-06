export type MenuGroup = { label: string; actions: Array<[string, () => void]> }

export class ContextMenu {
  private menu?: HTMLDivElement
  constructor(private readonly viewport: HTMLElement, private readonly onHide: () => void) {}
  contains(target: Node) { return this.menu?.contains(target) ?? false }
  hide() {
    this.onHide()
    this.menu?.remove()
    this.menu = undefined
  }
  show(x: number, y: number, groups: Array<{ label: string; actions: Array<[string, () => void]> }>) {
    this.hide()
    const menu = document.createElement('div')
    menu.className = 'colwork-table__context-menu'
    menu.setAttribute('aria-label', '表格操作')
    groups.forEach(({ label, actions }) => {
      const section = document.createElement('div')
      section.className = 'colwork-table__context-group'
      section.setAttribute('role', 'group')
      section.setAttribute('aria-label', label)
      const caption = document.createElement('div')
      caption.className = 'colwork-table__context-label'
      caption.textContent = label
      section.append(caption)
      actions.forEach(([label, action]) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        if (label.startsWith('删除') || label === '清空内容') button.className = 'is-destructive'
        button.addEventListener('click', () => {
          this.hide()
          action()
        })
        section.append(button)
      })
      menu.append(section)
    })
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.hide()
        this.viewport.focus({ preventScroll: true })
        return
      }
      const buttons = Array.from(menu.querySelectorAll('button'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      let next: number
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
      else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = buttons.length - 1
      else return
      event.preventDefault()
      buttons[next]?.focus()
    })
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    document.body.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    this.menu = menu
    menu.querySelector('button')?.focus({ preventScroll: true })
  }
}
