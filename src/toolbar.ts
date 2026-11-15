import type { CellStyle } from './model-schema'
import type { BooleanStyleKey, BorderMode } from './formatting'
type MenuGroup = { label: string; actions: Array<[string, () => void]> }

type ToolbarActions = {
  readOnly: boolean
  view: { bandedRows: boolean; showGridLines: boolean }
  undo(): void
  redo(): void
  mergeSelection(): void
  unmergeSelection(): void
  hideContextMenu(): void
  showContextMenu(x: number, y: number, groups: MenuGroup[]): void
  protectionActions(): Array<[string, () => void]>
  freezeSelection(axis: 'row' | 'column'): void
  setFrozenPanes(rows: number, columns: number): unknown
  render(): void
  openRowView(): void
  openFind(): void
  chooseImage?(): void
  setStyle(format: 'color' | 'background' | 'align' | 'fontSize' | 'format', value: string | number | undefined): void
  toggleFormat(format: BooleanStyleKey): void
  clearFormatting(): void
  toggleBorder(mode: BorderMode): void
}

export function buildToolbar(actions: ToolbarActions) {
  let undoButton: HTMLButtonElement | undefined
  let redoButton: HTMLButtonElement | undefined
    const toolbar = document.createElement('div')
    toolbar.className = 'colwork-table__toolbar'
    if (actions.readOnly) toolbar.hidden = true
    toolbar.setAttribute('aria-label', '表格工具栏')
    const commandRow = document.createElement('div')
    commandRow.className = 'colwork-table__toolbar-row'
    const formatRow = document.createElement('div')
    formatRow.className = 'colwork-table__toolbar-row'
    toolbar.append(commandRow, formatRow)
    const group = (row: HTMLElement, label: string) => {
      const section = document.createElement('div')
      section.className = 'colwork-table__toolbar-group'
      section.setAttribute('role', 'group')
      section.setAttribute('aria-label', label)
      const caption = document.createElement('span')
      caption.className = 'colwork-table__group-label'
      caption.textContent = label
      section.append(caption)
      row.append(section)
      return section
    }
    const historyGroup = group(commandRow, '历史')
    const cellGroup = group(commandRow, '单元格')
    const protectionGroup = group(commandRow, '保护')
    const viewGroup = group(commandRow, '显示')
    const textGroup = group(formatRow, '文字')
    const alignmentGroup = group(formatRow, '对齐')
    const formatGroup = group(formatRow, '格式')
    const historyButtons: Array<[string, string, () => void]> = [
      ['撤销', '↶', () => actions.undo()],
      ['重做', '↷', () => actions.redo()],
    ]
    historyButtons.forEach(([title, label, action], index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `colwork-table__history colwork-table__history--${index === 0 ? 'undo' : 'redo'}`
      button.title = title
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      if (index === 0) undoButton = button
      else redoButton = button
      historyGroup.append(button)
    })
    const gridActions: Array<[string, string, () => void]> = [
      ['查找替换', '查找', () => actions.openFind()],
      ['合并单元格', '合并', () => actions.mergeSelection()],
      ['拆分单元格', '拆分', () => actions.unmergeSelection()],
    ]
    gridActions.forEach(([title, label, action]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'colwork-table__format colwork-table__grid-action'
      button.title = title
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      cellGroup.append(button)
    })
    if (actions.chooseImage) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'colwork-table__format'
      button.textContent = '插入图片'
      button.addEventListener('click', actions.chooseImage)
      cellGroup.append(button)
    }
    protectionGroup.querySelector('.colwork-table__group-label')?.remove()
    const protectionButton = document.createElement('button')

    protectionButton.type = 'button'
    protectionButton.className = 'colwork-table__format colwork-table__dropdown-trigger'
    protectionButton.textContent = '保护'
    protectionButton.title = '锁定、密码锁定与解锁'
    protectionButton.setAttribute('aria-label', '保护')
    protectionButton.setAttribute('aria-expanded', 'false')
    protectionButton.addEventListener('mousedown', event => event.preventDefault())
    protectionButton.addEventListener('click', () => {
      if (protectionButton.getAttribute('aria-expanded') === 'true') { actions.hideContextMenu(); return }
      const rect = protectionButton.getBoundingClientRect()
      actions.showContextMenu(rect.left, rect.bottom + 4, [{ label: '锁定与解锁', actions: actions.protectionActions() }])
      protectionButton.setAttribute('aria-expanded', 'true')
    })
    protectionButton.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); protectionButton.click() }
    })
    protectionGroup.append(protectionButton)
    const viewControl = document.createElement('div')
    viewControl.className = 'colwork-table__view-control'
    const viewButton = document.createElement('button')
    viewButton.type = 'button'
    viewButton.className = 'colwork-table__format'
    viewButton.textContent = '视图'
    viewButton.setAttribute('aria-label', '视图')
    viewButton.classList.add('colwork-table__dropdown-trigger')
    viewButton.title = '本地视图选项'
    const viewMenu = document.createElement('div')
    viewMenu.className = 'colwork-table__view-menu'
    const viewOptions: Array<[string, () => boolean, (value: boolean) => void]> = [
      ['隔行异色', () => actions.view.bandedRows, (value) => { actions.view.bandedRows = value }],
      ['显示网格线', () => actions.view.showGridLines, (value) => { actions.view.showGridLines = value }],
    ]
    viewOptions.forEach(([label, getValue, setValue]) => {
      const option = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = getValue()
      checkbox.addEventListener('change', () => { setValue(checkbox.checked); actions.render() })
      option.append(checkbox, document.createTextNode(label))
      viewMenu.append(option)
    })
    const freezeActions: Array<[string, () => void]> = [
      ['固定至选中行', () => actions.freezeSelection('row')],
      ['固定至选中列', () => actions.freezeSelection('column')],
      ['取消固定', () => actions.setFrozenPanes(0, 0)],
    ]
    freezeActions.forEach(([label, action]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', action)
      viewMenu.append(button)
    })
    viewControl.append(viewButton, viewMenu)
    viewGroup.append(viewControl)
    const rowView = document.createElement('button')
    rowView.type = 'button'
    rowView.className = 'colwork-table__format'
    rowView.textContent = '排序筛选'
    rowView.title = '仅调整当前视图'
    rowView.addEventListener('click', actions.openRowView)
    viewGroup.append(rowView)
    ;[
      ['bold', 'B', '加粗'],
      ['italic', 'I', '斜体'],
      ['underline', 'U', '下划线'],
      ['strike', 'S', '删除线'],
      ['wrap', '换行', '自动换行'],
      ['align-left', '左', '左对齐'],
      ['align-center', '中', '居中'],
      ['align-right', '右', '右对齐'],
    ].forEach(([format, label, title]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `colwork-table__format colwork-table__format--${format}`
      button.textContent = label
      button.title = title
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => format.startsWith('align-') ? actions.setStyle('align', format.slice(6) as CellStyle['align']) : actions.toggleFormat(format as BooleanStyleKey))
      ;(format.startsWith('align-') || format === 'wrap' ? alignmentGroup : textGroup).append(button)
    })
    const fontSize = document.createElement('select')
    fontSize.className = 'colwork-table__select'
    fontSize.title = '字体大小'
    ;[10, 12, 14, 16, 18, 24].forEach((size) => {
      const option = document.createElement('option')
      option.value = String(size)
      option.textContent = `${size}px`
      fontSize.append(option)
    })
    fontSize.addEventListener('change', () => actions.setStyle('fontSize', Number(fontSize.value)))
    textGroup.append(fontSize)
    const numberFormat = document.createElement('select')
    numberFormat.className = 'colwork-table__select'
    numberFormat.title = '单元格格式'
    ;[
      ['general', '常规'],
      ['number', '数字'],
      ['date', '日期'],
      ['percent', '百分比'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      numberFormat.append(option)
    })
    numberFormat.addEventListener('change', () => actions.setStyle('format', numberFormat.value as CellStyle['format']))
    formatGroup.append(numberFormat)
    const clearFormat = document.createElement('button')
    clearFormat.type = 'button'
    clearFormat.className = 'colwork-table__format'
    clearFormat.title = '清除格式'
    clearFormat.textContent = '清除'
    clearFormat.addEventListener('mousedown', (event) => event.preventDefault())
    clearFormat.addEventListener('click', () => actions.clearFormatting())
    formatGroup.append(clearFormat)
    const borderControl = document.createElement('div')
    borderControl.className = 'colwork-table__border-control'
    const borderButton = document.createElement('button')
    borderButton.type = 'button'
    borderButton.className = 'colwork-table__format'
    borderButton.title = '边框选项'
    borderButton.textContent = '边框'
    borderButton.setAttribute('aria-label', '边框')
    borderButton.classList.add('colwork-table__dropdown-trigger')
    const borderMenu = document.createElement('div')
    borderMenu.className = 'colwork-table__border-menu'
    ;[
      ['外围', 'outer'],
      ['中间', 'inner'],
      ['横线', 'horizontal'],
      ['竖线', 'vertical'],
    ].forEach(([label, mode]) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.textContent = label
      option.addEventListener('click', () => actions.toggleBorder(mode as BorderMode))
      borderMenu.append(option)
    })
    borderControl.append(borderButton, borderMenu)
    formatGroup.insertBefore(borderControl, clearFormat)
    ;[
      ['color', '文字颜色'],
      ['background', '背景颜色'],
    ].forEach(([format, title]) => {
      const input = document.createElement('input')
      input.type = 'color'
      input.className = `colwork-table__color colwork-table__color--${format}`
      input.title = title
      input.addEventListener('input', () => actions.setStyle(format as 'color' | 'background', input.value))
      ;(format === 'color' ? textGroup : formatGroup).append(input)
    })
  return { toolbar, undoButton, redoButton, protectionButton }
}
