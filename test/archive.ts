import type { ColworkTable } from '@colwork-demo'
import { demoAllowsExport } from './user-settings'

export function downloadTableArchive(table: ColworkTable | null | undefined, kind: 'snapshot' | 'update-log') {
  // The npm demo can also mount releases published before view policies existed.
  if (!demoAllowsExport || !table || table.canExport?.() === false) return
  const archive = kind === 'snapshot' ? table.getYjsSnapshot() : table.getYjsUpdateLog()
  downloadJson(`colwork.${kind}.json`, archive)
}

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}
