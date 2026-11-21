import { imageLabel, readCellImage } from './cellImage'
import { excelColumn } from './formulas'
import { parseCellKey } from './model-schema'
import type { WorkbookSheetChange } from './model-diff'

function address(key: string) {
  const position = parseCellKey(key)
  return position ? excelColumn(position.column) + (position.row + 1) : key
}

function previewText(value: string | undefined) {
  if (value === undefined) return '（无）'
  if (!value) return '（空文本）'
  const image = readCellImage(value)
  if (image) return `图片 · ${imageLabel(image)}`
  return value.length <= 160 ? value : value.slice(0, 160) + '…'
}

export function renderVersionPreview(output: HTMLElement, changes: WorkbookSheetChange[], baseline: string, target: string) {
  const doc = output.ownerDocument
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const result = doc.createElement(tag)
    if (text !== undefined) result.textContent = text
    return result
  }
  output.replaceChildren(element('h4', '版本差异'), element('p', `${baseline} → ${target}`))
  if (!changes.length) {
    output.append(element('p', '没有内容差异'))
    return
  }
  const labels = {
    dimensions: '行列范围', styles: '单元格格式', rowHeights: '行高', columnWidths: '列宽',
    merges: '合并区域', locks: '保护设置',
  }
  const ruleLabels = { validation: '数据验证', conditional: '条件格式', analyses: '图表或透视' }
  const changeLabels = { added: '新增', removed: '移除', modified: '修改' }
  for (const change of changes) {
    const details = element('details')
    details.open = output.querySelector('details') === null
    const action = changeLabels[change.change]
    const summary = [`${change.name}（${action}）`]
    if (change.previousName !== undefined) summary.push(`原名 ${change.previousName}`)
    if (change.moved) summary.push('顺序变更')
    if (change.cells.count) summary.push(`${change.cells.count} 个单元格`)
    if (change.rules.count) summary.push(`${change.rules.count} 个规则或分析`)
    details.append(element('summary', summary.join(' · ')))
    if (change.properties.length) details.append(element('p', change.properties.map(property => labels[property]).join('、')))
    if (change.rules.precedenceChanged) details.append(element('p', '规则优先级变更'))
    for (const rule of change.rules.examples) {
      const location = rule.kind === 'analyses' ? '' : ' ' + rule.key.split('-').map(address).join('–')
      details.append(element('p', ruleLabels[rule.kind] + location + ' · ' + changeLabels[rule.change]))
    }
    if (change.cells.examples.length) {
      const table = element('table')
      const header = table.createTHead().insertRow()
      for (const label of ['单元格', '基准版本', '所选版本']) header.append(element('th', label))
      const body = table.createTBody()
      for (const cell of change.cells.examples) {
        const row = body.insertRow()
        row.append(element('th', address(cell.key)), element('td', previewText(cell.before)), element('td', previewText(cell.after)))
      }
      details.append(table)
    }
    if (change.cells.examples.length < change.cells.count || change.rules.examples.length < change.rules.count) {
      details.append(element('p', '仅显示部分差异'))
    }
    output.append(details)
  }
}
