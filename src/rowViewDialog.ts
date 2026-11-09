import type { ColworkRowView } from './options'
import { excelColumn } from './formulas'

export function openRowViewDialog(root: HTMLElement, current: ColworkRowView, column: number, columns: number, apply: (view: ColworkRowView) => void) {
  const doc = root.ownerDocument
  const dialog = doc.createElement('dialog')
  dialog.className = 'colwork-table__row-view'
  dialog.setAttribute('aria-label', '个人排序筛选')
  const form = doc.createElement('form')
  const heading = doc.createElement('h3')
  heading.textContent = '个人排序筛选'
  const explanation = doc.createElement('p')
  explanation.textContent = '只调整你看到的行顺序和范围。'
  const columnSelect = (selected: number) => {
    const select = doc.createElement('select')
    for (let index = 0; index < Math.min(columns, 16384); index++) {
      select.add(new Option(excelColumn(index), String(index), false, index === selected))
    }
    select.setAttribute('aria-label', '列')
    return select
  }
  const sortColumn = columnSelect(current.sort?.column ?? column)
  const direction = doc.createElement('select')
  direction.setAttribute('aria-label', '排序方向')
  for (const [text, value] of [['不排序', ''], ['升序', 'asc'], ['降序', 'desc']]) direction.add(new Option(text, value, false, (current.sort?.direction ?? '') === value))
  const sort = doc.createElement('div')
  sort.append(doc.createTextNode('排序 '), sortColumn, direction)
  const header = doc.createElement('input')
  header.type = 'number'
  header.min = '0'
  header.step = '1'
  header.value = String(current.headerRows ?? 0)
  header.setAttribute('aria-label', '保留标题行数')
  const headerRow = doc.createElement('label')
  headerRow.append('保留标题行数 ', header)
  const filters = doc.createElement('div')
  const conditions: Array<{ row: HTMLElement; column: HTMLSelectElement; text: HTMLInputElement }> = []
  function addFilter(selected: number, contains: string) {
    const row = doc.createElement('div')
    const column = columnSelect(selected)
    const text = doc.createElement('input')
    text.placeholder = '包含文字'
    text.setAttribute('aria-label', '筛选关键词')
    text.value = contains
    const remove = doc.createElement('button')
    remove.type = 'button'
    remove.textContent = '移除'
    remove.onclick = () => row.remove()
    row.append(column, text, remove)
    filters.append(row)
    conditions.push({ row, column, text })
  }
  for (const filter of current.filters ?? []) addFilter(filter.column, filter.contains)
  const add = doc.createElement('button')
  add.type = 'button'
  add.textContent = '添加筛选条件'
  add.onclick = () => addFilter(column, '')
  const error = doc.createElement('p')
  error.setAttribute('role', 'alert')
  const actions = doc.createElement('div')
  const save = doc.createElement('button')
  save.textContent = '应用到我的视图'
  const clear = doc.createElement('button')
  clear.type = 'button'
  clear.textContent = '清除排序筛选'
  clear.onclick = () => { apply({}); dialog.close() }
  const cancel = doc.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '取消'
  cancel.onclick = () => dialog.close()
  actions.append(cancel, clear, save)
  form.append(heading, explanation, sort, headerRow, filters, add, error, actions)
  form.onsubmit = event => {
    event.preventDefault()
    try {
      apply({
        headerRows: Number(header.value),
        sort: direction.value ? { column: Number(sortColumn.value), direction: direction.value as 'asc' | 'desc' } : undefined,
        filters: conditions.filter(({ row }) => row.isConnected).map(condition => ({ column: Number(condition.column.value), contains: condition.text.value })),
      })
      dialog.close()
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : '无法应用视图' }
  }
  dialog.append(form)
  root.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  dialog.showModal()
  return dialog
}
