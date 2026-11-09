import type { SheetDocument } from './sheetDocument'
export const defaultRows = [
  ['设计协作表格', '小林', '进行中', '高', '2026-08-07', '欢迎测试'],
  ['整理组件 API', '阿南', '已完成', '中', '2026-08-08', '已补充示例'],
  ['补充单元测试', '小周', '未开始', '高', '2026-08-09', '覆盖边界输入'],
  ['实现虚拟滚动', '小林', '进行中', '高', '2026-08-10', '先支持行虚拟化'],
  ['接入 WebSocket', '阿南', '已完成', '中', '2026-08-11', '等待联调'],
  ['增加复制粘贴', '小周', '进行中', '中', '2026-08-12', '支持 TSV 格式'],
  ['检查 Safari 兼容性', '小雨', '阻塞', '高', '2026-08-13', '需要补充 ICE 日志'],
  ['编写使用文档', '阿南', '未开始', '低', '2026-08-14', '准备 API 清单'],
  ['优化移动端布局', '小雨', '未开始', '中', '2026-08-15', '检查横向滚动'],
  ['发布 v0.1.0', '小林', '未开始', '低', '2026-08-18', '等待最终验收'],
]

export function seedDemoFormatting(sheet: SheetDocument) {
  sheet.doc.transact(() => {
    sheet.cells.set('0:0', '设计协作表格\n多人协作工作区')
    sheet.cells.delete('0:1')
    sheet.cells.delete('0:2')
    sheet.merges.set('0:0-0:2', '1')
    sheet.styles.set('0:0', JSON.stringify({ bold: true, fontSize: 16, color: '#0f172a', background: '#bae6fd', align: 'center', wrap: true, border: { top: true, right: true, bottom: true, left: true } }))
    sheet.styles.set('1:0', JSON.stringify({ bold: true, underline: true, background: '#fef3c7', border: { bottom: true } }))
    sheet.styles.set('1:1', JSON.stringify({ italic: true, color: '#7c3aed' }))
    sheet.styles.set('1:2', JSON.stringify({ strike: true, color: '#b91c1c' }))
    sheet.cells.set('2:0', '125000')
    sheet.styles.set('2:0', JSON.stringify({ format: 'number', fontSize: 14, border: { top: true, bottom: true } }))
    sheet.cells.set('2:1', '0.72')
    sheet.styles.set('2:1', JSON.stringify({ format: 'percent', color: '#047857', align: 'right' }))
    sheet.cells.set('2:2', '2026-08-09')
    sheet.styles.set('2:2', JSON.stringify({ format: 'date', background: '#dcfce7' }))
    sheet.cells.set('3:0', '这是一段较长的演示内容\n可使用自动换行工具查看')
    sheet.styles.set('3:0', JSON.stringify({ wrap: true, background: '#f1f5f9', border: { top: true, right: true, bottom: true, left: true } }))
    sheet.cells.set('4:0', '删除线示例')
    sheet.styles.set('4:0', JSON.stringify({ strike: true, color: '#64748b' }))
    sheet.cells.set('5:0', '合并区域示例')
    sheet.cells.delete('5:1')
    sheet.cells.delete('5:2')
    sheet.merges.set('5:0-5:2', '1')
    sheet.styles.set('5:0', JSON.stringify({ bold: true, align: 'center', background: '#ede9fe', border: { top: true, right: true, bottom: true, left: true } }))
    sheet.rowHeights.set('0', 52)
    sheet.rowHeights.set('3', 56)
    sheet.rowHeights.set('5', 44)
    sheet.columnWidths.set('0', 220)
    sheet.columnWidths.set('1', 130)
    sheet.columnWidths.set('2', 130)
  })
}
