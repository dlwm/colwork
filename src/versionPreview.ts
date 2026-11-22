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

export function removeVersionPreviewValues(output: HTMLElement) {
  output.querySelectorAll('[data-colwork-version-value]').forEach(cell => cell.remove())
}

export function renderVersionPreview(output: HTMLElement, changes: WorkbookSheetChange[], baseline: string, target: string, showValues: boolean) {
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
      header.append(element('th', '单元格'))
      if (showValues) {
        for (const label of ['基准版本', '所选版本']) {
          const heading = element('th', label)
          heading.setAttribute('data-colwork-version-value', '')
          header.append(heading)
        }
      }
      const body = table.createTBody()
      for (const cell of change.cells.examples) {
        const row = body.insertRow()
        const coordinate = element('th', address(cell.key))
        coordinate.scope = 'row'
        row.append(coordinate)
        if (showValues) {
          for (const value of [cell.before, cell.after]) {
            const valueCell = element('td', previewText(value))
            valueCell.setAttribute('data-colwork-version-value', '')
            row.append(valueCell)
          }
        }
      }
      details.append(table)
    }
    if (change.cells.examples.length < change.cells.count || change.rules.examples.length < change.rules.count) {
      details.append(element('p', '仅显示部分差异'))
    }
    output.append(details)
  }
}
