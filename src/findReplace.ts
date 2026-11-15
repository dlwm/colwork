import type { CellPosition } from './range'

export function openFindReplace(root: HTMLElement, readOnly: boolean, find: (query: string) => CellPosition[],
  select: (position: CellPosition) => void, replace: (query: string, replacement: string, position?: CellPosition) => number) {
  const doc = root.ownerDocument
  const dialog = doc.createElement('dialog')
  dialog.className = 'colwork-table__feature-dialog'
  dialog.setAttribute('aria-label', '查找替换')
  const query = doc.createElement('input')
  query.placeholder = '查找内容'
  query.setAttribute('aria-label', '查找内容')
  const replacement = doc.createElement('input')
  replacement.placeholder = '替换为'
  replacement.setAttribute('aria-label', '替换为')
  const status = doc.createElement('span')
  status.setAttribute('role', 'status')
  let index = -1
  let current: CellPosition | undefined
  const next = () => {
    const matches = query.value ? find(query.value) : []
    index = (index + 1) % Math.max(1, matches.length)
    current = matches[index]
    if (current) select(current)
    status.textContent = matches.length ? `${index + 1} / ${matches.length}` : '无匹配项'
  }
  const button = (label: string, action: () => void) => {
    const item = doc.createElement('button')
    item.type = 'button'
    item.textContent = label
    item.onclick = action
    return item
  }
  query.addEventListener('input', () => { index = -1; current = undefined; status.textContent = '' })
  query.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); next() }
  })
  dialog.append(query, button('查找下一项', next))
  if (!readOnly) {
    const apply = (all: boolean) => {
      if (!query.value || (!all && !current)) return
      try {
        status.textContent = `已替换 ${replace(query.value, replacement.value, all ? undefined : current)} 个单元格`
        index = -1
        current = undefined
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '替换失败'
      }
    }
    dialog.append(replacement, button('替换当前项', () => apply(false)), button('全部替换文本', () => apply(true)))
  }
  dialog.append(status, button('关闭', () => dialog.close()))
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  root.append(dialog)
  dialog.showModal()
  query.focus()
  return dialog
}
