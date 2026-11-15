import type { CellRange } from './range'

type Aggregate = { count: number; sum: number; numeric: number }

export function summarizeRange(range: CellRange, group: number, value: number, column: number | undefined,
  method: 'sum' | 'count' | 'average', read: (row: number, column: number) => string) {
  const groups = new Map<string, Map<string, Aggregate>>()
  const columns = new Set<string>()
  if (range.end.row - range.start.row > 100000) throw new RangeError('分析范围最多十万行')
  const result = (item?: Aggregate) => item ? method === 'count' ? item.count : method === 'average'
    ? (item.numeric ? item.sum / item.numeric : 0) : item.sum : 0
  for (let row = range.start.row + 1; row <= range.end.row; row++) {
    const label = read(row, group)
    const category = column === undefined ? '汇总' : read(row, column) || '（空白）'
    const raw = read(row, value)
    if (!label && !raw) continue
    const key = label || '（空白）'
    if (!groups.has(key)) groups.set(key, new Map())
    columns.add(category)
    if (groups.size > 500 || columns.size > 50 || groups.size * columns.size > 5000) throw new RangeError('分组结果过多，请缩小范围')
    const entries = groups.get(key)!
    const aggregate = entries.get(category) ?? { count: 0, sum: 0, numeric: 0 }
    if (raw !== '') {
      aggregate.count++
      const number = Number(raw)
      if (raw.trim() && Number.isFinite(number)) { aggregate.sum += number; aggregate.numeric++ }
    }
    entries.set(category, aggregate)
  }
  return { columns: [...columns], rows: [...groups].map(([label, values]) =>
    ({ label, values: [...columns].map(column => result(values.get(column))) })) }
}
