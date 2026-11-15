import { summarizeRange } from './analysis'
import { excelColumn } from './formulas'
import type { CellRange } from './range'
import { isAnalysis, isConditionalFormat, isDataValidation, type ColworkAnalysis, type ColworkConditionalFormat, type ColworkDataValidation } from './sheetFeatures'

type RuleHost = {
  root: HTMLElement
  validation?: ColworkDataValidation
  conditional?: ColworkConditionalFormat
  saveValidation(rule?: ColworkDataValidation): void
  saveConditional(rule?: ColworkConditionalFormat): void
}

function control<T extends HTMLElement>(name: string, element: T) {
  const label = element.ownerDocument.createElement('label')
  label.append(name, element)
  return label
}
function button(doc: Document, label: string, action: () => void) {
  const result = doc.createElement('button')
  result.type = 'button'
  result.textContent = label
  result.onclick = action
  return result
}
function choice(doc: Document, name: string, entries: Array<[string, string]>) {
  const select = doc.createElement('select')
  select.setAttribute('aria-label', name)
  for (const [value, text] of entries) {
    const option = doc.createElement('option')
    option.value = value
    option.textContent = text
    select.append(option)
  }
  return select
}
function dialogFor(root: HTMLElement, title: string) {
  const doc = root.ownerDocument
  const dialog = doc.createElement('dialog')
  dialog.className = 'colwork-table__feature-dialog'
  dialog.setAttribute('aria-label', title)
  const heading = doc.createElement('h3')
  heading.textContent = title
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  const act = (action: () => void) => {
    try { status.textContent = ''; action() }
    catch (error) { status.textContent = error instanceof Error ? error.message : '操作失败' }
  }
  dialog.append(heading)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  const show = () => {
    dialog.append(status, button(doc, '关闭', () => dialog.close()))
    root.append(dialog)
    dialog.showModal()
    return dialog
  }
  return { doc, dialog, status, act, show }
}

export function openRuleDialog(host: RuleHost, kind: 'validation' | 'conditional') {
  const { doc, dialog, act, show } = dialogFor(host.root, kind === 'validation' ? '下拉选项' : '条件格式')
  if (kind === 'validation') {
    const input = doc.createElement('textarea')
    input.setAttribute('aria-label', '选项列表')
    input.rows = 5
    input.placeholder = '每行一个选项'
    input.value = host.validation?.choices.join('\n') ?? ''
    dialog.append(control('选项列表', input), button(doc, '设置下拉选项', () => act(() => {
      const rule = { choices: [...new Set(input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))] }
      if (!isDataValidation(rule)) throw new Error('请输入 1–100 个选项，每项最多 255 字符')
      host.saveValidation(rule)
      dialog.close()
    })), button(doc, '移除下拉选项', () => act(() => { host.saveValidation(); dialog.close() })))
  } else {
    const operator = choice(doc, '匹配条件', [['contains', '包含'], ['equals', '等于'], ['greater', '大于'], ['less', '小于'], ['empty', '空白']])
    operator.value = host.conditional?.operator ?? 'contains'
    const value = doc.createElement('input')
    value.setAttribute('aria-label', '比较值')
    value.value = host.conditional?.value ?? ''
    value.maxLength = 255
    const color = doc.createElement('input')
    color.setAttribute('aria-label', '高亮颜色')
    color.type = 'color'
    color.value = host.conditional?.background ?? '#fef3c7'
    dialog.append(control('匹配条件', operator), control('比较值', value), control('高亮颜色', color),
      button(doc, '保存条件格式', () => act(() => {
        const rule = { operator: operator.value, value: value.value, background: color.value }
        if (!isConditionalFormat(rule)) throw new Error('条件或比较值无效')
        host.saveConditional(rule)
        dialog.close()
      })), button(doc, '移除条件格式', () => act(() => { host.saveConditional(); dialog.close() })))
  }
  return show()
}

type AnalysisHost = {
  root: HTMLElement
  range?: CellRange
  rangeId?: string
  readOnly: boolean
  analyses: Array<[string, ColworkAnalysis]>
  resolve(range: string): CellRange | undefined
  columnId(column: number): string
  columnPosition(id: string): number | undefined
  subscribe(refresh: () => void): () => void
  read(row: number, column: number): string
  save(rule: ColworkAnalysis): void
  remove(id: string): void
}

function showResults(doc: Document, output: HTMLElement, rule: ColworkAnalysis, data: ReturnType<typeof summarizeRange>) {
  output.replaceChildren()
  if (!data.rows.length) { output.textContent = '没有可汇总的数据'; return }
  if (rule.kind !== 'pivot') {
    const canvas = doc.createElement('canvas')
    canvas.width = 600
    canvas.height = 260
    canvas.setAttribute('aria-label', rule.name)
    canvas.setAttribute('role', 'img')
    const points = data.rows.slice(0, 40)
    const context = canvas.getContext('2d')
    if (context) {
      const min = Math.min(0, ...points.map(row => row.values[0]))
      const max = Math.max(1, ...points.map(row => row.values[0]))
      const space = 540 / points.length
      const y = (value: number) => 215 - 185 * (value - min) / (max - min)
      context.strokeStyle = '#cbd5e1'
      context.beginPath()
      context.moveTo(36, y(0)); context.lineTo(580, y(0)); context.stroke()
      context.fillStyle = '#2563eb'
      context.strokeStyle = '#2563eb'
      context.beginPath()
      points.forEach((row, index) => {
        const x = 42 + space * (index + 0.5)
        const end = y(row.values[0])
        if (rule.kind === 'bar') context.fillRect(x - space / 3, Math.min(end, y(0)), space * 2 / 3, Math.abs(y(0) - end))
        else if (index === 0) context.moveTo(x, end)
        else context.lineTo(x, end)
      })
      if (rule.kind === 'line') {
        context.stroke()
        points.forEach((row, index) => {
          context.beginPath()
          context.arc(42 + space * (index + 0.5), y(row.values[0]), 3, 0, 2 * Math.PI)
          context.fill()
        })
      }
      context.font = '11px system-ui'
      context.fillStyle = '#475569'
      points.forEach((row, index) => {
        if (index % Math.ceil(points.length / 10) === 0) {
          context.fillText(row.label.slice(0, 10), 40 + space * index, 240, space * Math.ceil(points.length / 10) - 4)
        }
      })
    }
    output.append(canvas)
    if (data.rows.length > 40) output.append('图中显示前 40 个分组')
  }
  const table = doc.createElement('table')
  const header = table.createTHead().insertRow()
  for (const title of ['分组', ...data.columns]) {
    const cell = doc.createElement('th')
    cell.scope = 'col'
    cell.textContent = title
    header.append(cell)
  }
  const body = table.createTBody()
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })
  for (const row of data.rows) {
    const line = body.insertRow()
    const label = doc.createElement('th')
    label.scope = 'row'
    label.textContent = row.label
    line.append(label)
    row.values.forEach(value => { line.insertCell().textContent = formatter.format(value) })
  }
  output.append(table)
}

export function openAnalysisDialog(host: AnalysisHost) {
  const { doc, dialog, act, show } = dialogFor(host.root, '图表与数据透视')
  const previous = choice(doc, '已保存分析', [['', '选择已保存的分析'], ...host.analyses.map(([id, rule]): [string, string] => [id, rule.name])])
  const output = doc.createElement('div')
  output.className = 'colwork-table__analysis-result'
  let active: ColworkAnalysis | undefined
  const render = (rule: ColworkAnalysis) => {
    active = rule
    const range = host.resolve(rule.range)
    if (!range) throw new Error('分析的数据范围已删除')
    const group = host.columnPosition(rule.group), value = host.columnPosition(rule.value)
    const column = rule.column === undefined ? undefined : host.columnPosition(rule.column)
    const invalid = (index: number | undefined) => index === undefined || index < range.start.column || index > range.end.column
    if (invalid(group) || invalid(value) || (rule.column !== undefined && invalid(column))) {
      throw new Error('分析引用的列已删除')
    }
    showResults(doc, output, rule, summarizeRange(range, group!, value!, column, rule.summarize, host.read))
  }
  dialog.append(control('已保存分析', previous))
  previous.onchange = () => act(() => {
    output.replaceChildren()
    const rule = host.analyses.find(([id]) => id === previous.value)?.[1]
    active = rule
    if (rule) render(rule)
  })
  if (!host.readOnly) {
    dialog.append(button(doc, '删除选中的分析', () => act(() => {
      if (!previous.value) return
      host.remove(previous.value)
      dialog.close()
    })))
  }
  if (host.range && host.rangeId && !host.readOnly) {
    const kind = choice(doc, '分析类型', [['bar', '柱状图'], ['line', '折线图'], ['pivot', '数据透视表']])
    const name = doc.createElement('input')
    name.placeholder = '名称'
    name.setAttribute('aria-label', '分析名称')
    name.maxLength = 80
    const range = host.range
    const fields: Array<[string, string]> = Array.from({ length: range.end.column - range.start.column + 1 }, (_, index) => {
      const absolute = range.start.column + index
      return [host.columnId(absolute), host.read(range.start.row, absolute) || excelColumn(absolute)]
    })
    const group = choice(doc, '分组列', fields)
    const value = choice(doc, '数值列', fields)
    value.selectedIndex = Math.min(1, fields.length - 1)
    const column = choice(doc, '透视列', [['', '无'], ...fields])
    column.disabled = true
    kind.onchange = () => { column.disabled = kind.value !== 'pivot' }
    const summarize = choice(doc, '汇总方式', [['sum', '求和'], ['count', '计数'], ['average', '平均值']])
    const config = () => {
      const rule = { name: name.value.trim() || kind.selectedOptions[0].textContent, kind: kind.value, range: host.rangeId!,
        group: group.value, value: value.value, column: column.disabled || !column.value ? undefined : column.value, summarize: summarize.value }
      if (!isAnalysis(rule)) throw new Error('分析设置有误')
      return rule
    }
    dialog.append(control('分析类型', kind), control('名称', name), control('分组列', group), control('数值列', value),
      control('透视列', column), control('汇总方式', summarize),
      button(doc, '预览分析', () => act(() => render(config()))),
      button(doc, '保存分析', () => act(() => { const rule = config(); render(rule); host.save(rule); dialog.close() })))
  }
  const unsubscribe = host.subscribe(() => {
    if (active && dialog.open) act(() => { output.replaceChildren(); render(active!) })
  })
  dialog.addEventListener('close', unsubscribe, { once: true })
  dialog.append(output)
  return show()
}
