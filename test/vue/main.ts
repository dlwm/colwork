import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ColworkTable } from '../../src'
import { classifyLog, formatLog, loadLogTypes, logTypes, saveLogTypes, type LogEntry, type LogType } from '../log'
import { splitHexGroups, splitLogText } from '../identifiers'
import { downloadJson } from '../archive'
import { loadUserSettings, saveUserSettings, websocketUrl, collaborationTransport, cloudflareDeployment, type UserSettings } from '../user-settings'
import '../test.css'

const transport = collaborationTransport()
const initialUserSettings = loadUserSettings('vue')

const App = defineComponent({
  setup() {
    const tableRoot = ref<HTMLElement | null>(null)
    const logRoot = ref<HTMLElement | null>(null)
    const logs = ref<LogEntry[]>([])
    const recording = ref(true)
    const activeTypes = ref<Set<LogType>>(loadLogTypes())
    let stickToBottom = true
    let table: ColworkTable | undefined
    const draft = ref<UserSettings>({ ...initialUserSettings })
    const applied = ref<UserSettings>({ ...initialUserSettings })
    const expanded = ref(new Set<string>())
    const textNodes = (text: string) => splitLogText(text).map((segment, index) => {
      if (segment.kind === 'hex') return h('span', { key: index, class: 'log-hex', style: { backgroundColor: segment.color } }, segment.text)
      if (segment.kind === 'hex-more' && segment.full) {
        const key = `hex:${segment.full}`
        if (expanded.value.has(key)) return h('span', { key: index }, [splitHexGroups(segment.full).map((group, groupIndex) => h('span', { key: groupIndex, class: 'log-hex', style: { backgroundColor: group.color } }, group.text)), h('button', { class: 'log-hex-more', type: 'button', onClick: () => { const next = new Set(expanded.value); next.delete(key); expanded.value = next } }, segment.text)])
        return h('button', { key: index, class: 'log-hex-more', type: 'button', onClick: () => { const next = new Set(expanded.value); next.add(key); expanded.value = next } }, segment.text)
      }
      if (!segment.full) return h('span', { key: index }, segment.text)
      const isExpanded = expanded.value.has(segment.full)
      return h('button', { key: `${segment.full}-${index}`, class: 'log-id', title: isExpanded ? '收起' : segment.full, style: { backgroundColor: segment.color }, onClick: () => { const next = new Set(expanded.value); if (isExpanded) next.delete(segment.full!); else next.add(segment.full!); expanded.value = next } }, isExpanded ? segment.full : segment.text)
    })
    const jsonNode = (value: unknown): ReturnType<typeof h> => {
      if (Array.isArray(value)) return h('details', { class: 'json-node' }, [h('summary', ['[…] ', h('span', { class: 'json-count' }, `${value.length} items`)]), h('div', { class: 'json-tree' }, value.map((item, index) => h('div', { class: 'json-row', key: index }, [h('span', { class: 'json-key' }, `${index}`), jsonNode(item)])))])
      if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
        return h('details', { class: 'json-node' }, [h('summary', ['{…} ', h('span', { class: 'json-count' }, `${entries.length} fields`)]), h('div', { class: 'json-tree' }, entries.map(([key, item]) => h('div', { class: 'json-row', key }, [h('span', { class: 'json-key' }, key), jsonNode(item)])))])
      }
      return h('span', { class: 'json-value' }, JSON.stringify(value))
    }
    const appendLog = (text: string) => {
      if (!recording.value) return
      const entry = classifyLog(text)
      if (!activeTypes.value.has(entry.type)) return
      logs.value.push(entry)
      nextTick(() => { if (stickToBottom && logRoot.value) logRoot.value.scrollTop = logRoot.value.scrollHeight })
    }
    const toggleType = (type: LogType) => {
      const next = new Set(activeTypes.value)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      activeTypes.value = next
      saveLogTypes(next)
    }
    const mountTable = () => {
      table?.destroy()
      if (tableRoot.value) table = new ColworkTable(tableRoot.value, { room: 'colwork-demo', user: applied.value.nickname, userColor: applied.value.color, transport, initializeAfterSync: cloudflareDeployment, websocketUrl: websocketUrl(applied.value), onLog: appendLog })
    }
    const applySettings = async () => {
      applied.value = { ...draft.value, delay: Math.max(0, Math.min(30000, Number(draft.value.delay) || 0)) }
      await saveUserSettings(applied.value, 'vue')
      mountTable()
    }
    onMounted(() => {
      saveUserSettings(applied.value, 'vue').then(mountTable).catch(mountTable)
    })
    onBeforeUnmount(() => table?.destroy())
    return () => h('main', { class: 'test-shell' }, h('section', { class: 'panel' }, [
      h('div', { class: 'user-settings' }, [
        h('input', { value: draft.value.nickname, placeholder: '昵称', onInput: (event: Event) => { draft.value.nickname = (event.target as HTMLInputElement).value } }),
        h('span', { class: 'user-settings__delay' }, [h('input', { value: draft.value.delay, type: 'number', min: 0, max: 30000, placeholder: '延时', onInput: (event: Event) => { draft.value.delay = Number((event.target as HTMLInputElement).value) } }), h('span', { class: 'user-settings__unit' }, 'ms')]),
         h('input', { value: draft.value.color, type: 'color', onInput: (event: Event) => { draft.value.color = (event.target as HTMLInputElement).value } }),
          h('button', { type: 'button', onClick: applySettings }, '应用'),
          h('button', { type: 'button', onClick: () => table && downloadJson('colwork.snapshot.json', table.getYjsSnapshot()) }, '导出快照'),
          h('button', { type: 'button', onClick: () => table && downloadJson('colwork.update-log.json', table.getYjsUpdateLog()) }, '导出更新日志'),
      ]),
      h('div', { ref: tableRoot }),
      h('div', { class: 'log-toolbar' }, [
        h('div', { class: 'log-filters' }, [h('button', { class: `log-playback ${recording.value ? 'is-recording' : ''}`, type: 'button', 'aria-label': recording.value ? '暂停日志记录' : '继续日志记录', onClick: () => { recording.value = !recording.value } }, recording.value ? 'Ⅱ' : '▶'), ...logTypes.map((type) => h('button', { class: `log-filter log-filter-${type} ${activeTypes.value.has(type) ? 'active' : ''}`, type: 'button', onClick: () => toggleType(type) }, type))]),
        h('button', { class: 'log-clear', type: 'button', 'aria-label': '清空日志', onClick: () => { logs.value = []; stickToBottom = true } }, '×'),
      ]),
      h('div', { ref: logRoot, class: 'log-window', role: 'log', onScroll: () => { if (logRoot.value) stickToBottom = logRoot.value.scrollHeight - logRoot.value.scrollTop - logRoot.value.clientHeight < 8 } }, logs.value.filter((log) => activeTypes.value.has(log.type)).map((log, index) => { const formatted = formatLog(log.text); return h('div', { class: `log-entry log-${log.type}`, key: `${log.text}-${index}` }, [h('span', { class: 'log-kind' }, log.type), formatted.json ? h('details', { class: 'log-json-block' }, [h('summary', textNodes(formatted.prefix)), jsonNode(formatted.value)]) : h('div', { class: 'log-body' }, textNodes(formatted.prefix))]) })),
    ]))
  },
})

createApp(App).mount('#app')
