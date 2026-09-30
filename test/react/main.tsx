import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ColworkTable } from '../../src'
import { classifyLog, formatLog, loadLogTypes, logTypes, saveLogTypes, type LogEntry, type LogType } from '../log'
import { splitHexGroups, splitLogText } from '../identifiers'
import { downloadJson } from '../archive'
import { loadUserSettings, saveUserSettings, websocketUrl, collaborationTransport, cloudflareDeployment, type UserSettings } from '../user-settings'
import '../test.css'

const transport = collaborationTransport()
const initialUserSettings = loadUserSettings('react')

function App() {
  const tableRoot = useRef<HTMLDivElement>(null)
  const logRoot = useRef<HTMLDivElement>(null)
  const tableRef = useRef<ColworkTable | undefined>(undefined)
  const stickToBottom = useRef(true)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [recording, setRecording] = useState(true)
  const recordingRef = useRef(true)
  const activeTypesRef = useRef<Set<LogType>>(loadLogTypes())
  const [activeTypes, setActiveTypes] = useState<Set<LogType>>(loadLogTypes)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<UserSettings>(() => ({ ...initialUserSettings }))
  const [applied, setApplied] = useState<UserSettings>(() => ({ ...initialUserSettings }))
  const appendLog = (text: string) => {
    if (!recordingRef.current) return
    const entry = classifyLog(text)
    if (!activeTypesRef.current.has(entry.type)) return
    setLogs((current) => [...current, entry])
  }
  useEffect(() => {
    if (!tableRoot.current) return
    let active = true
    let table: ColworkTable | undefined
    saveUserSettings(applied, 'react').catch(() => undefined).finally(() => {
       if (active && tableRoot.current) {
         table = new ColworkTable(tableRoot.current, { room: 'colwork-demo', user: applied.nickname, userColor: applied.color, transport, initializeAfterSync: cloudflareDeployment, websocketUrl: websocketUrl(applied), onLog: appendLog })
         tableRef.current = table
       }
    })
    return () => { active = false; table?.destroy(); if (tableRef.current === table) tableRef.current = undefined }
  }, [applied])
  useLayoutEffect(() => {
    if (!stickToBottom.current || !logRoot.current) return
    logRoot.current.scrollTop = logRoot.current.scrollHeight
  }, [logs])
  const toggleType = (type: LogType) => setActiveTypes((current) => {
    const next = new Set(current)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    activeTypesRef.current = next
    saveLogTypes(next)
    return next
  })
  const applySettings = async () => {
    const next = { ...draft, delay: Math.max(0, Math.min(30000, Number(draft.delay) || 0)) }
    await saveUserSettings(next, 'react')
    setApplied(next)
  }
  const textNodes = (text: string) => splitLogText(text).map((segment, index) => {
    if (segment.kind === 'hex') return <span className="log-hex" style={{ backgroundColor: segment.color }} key={index}>{segment.text}</span>
    if (segment.kind === 'hex-more' && segment.full) {
      const key = `hex:${segment.full}`
      if (expanded.has(key)) return <span key={index}>{splitHexGroups(segment.full).map((group, groupIndex) => <span className="log-hex" style={{ backgroundColor: group.color }} key={groupIndex}>{group.text}</span>)}<button className="log-hex-more" type="button" onClick={() => setExpanded((current) => { const next = new Set(current); next.delete(key); return next })}>{segment.text}</button></span>
      return <button className="log-hex-more" type="button" onClick={() => setExpanded((current) => new Set(current).add(key))} key={index}>{segment.text}</button>
    }
    if (!segment.full) return <span key={index}>{segment.text}</span>
    const isExpanded = expanded.has(segment.full)
    return <button className="log-id" style={{ backgroundColor: segment.color }} title={isExpanded ? '收起' : segment.full} onClick={() => setExpanded((current) => { const next = new Set(current); if (isExpanded) next.delete(segment.full!); else next.add(segment.full!); return next })} key={`${segment.full}-${index}`}>{isExpanded ? segment.full : segment.text}</button>
  })
  const jsonNode = (value: unknown): ReactNode => {
    if (Array.isArray(value)) return <details className="json-node"><summary>[…] <span className="json-count">{value.length} items</span></summary><div className="json-tree">{value.map((item, index) => <div className="json-row" key={index}><span className="json-key">{index}</span>{jsonNode(item)}</div>)}</div></details>
    if (value !== null && typeof value === 'object') return <details className="json-node"><summary>{'{…} '}<span className="json-count">{Object.keys(value).length} fields</span></summary><div className="json-tree">{Object.entries(value).map(([key, item]) => <div className="json-row" key={key}><span className="json-key">{key}</span>{jsonNode(item)}</div>)}</div></details>
    return <span className="json-value">{JSON.stringify(value)}</span>
  }
  return <main className="test-shell"><section className="panel">
      <div className="user-settings"><input value={draft.nickname} placeholder="昵称" onChange={(event) => setDraft({ ...draft, nickname: event.target.value })} /><span className="user-settings__delay"><input value={draft.delay} type="number" min="0" max="30000" placeholder="延时" onChange={(event) => setDraft({ ...draft, delay: Number(event.target.value) })} /><span className="user-settings__unit">ms</span></span><input value={draft.color} type="color" onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><button type="button" onClick={applySettings}>应用</button><button type="button" onClick={() => tableRef.current && downloadJson('colwork.snapshot.json', tableRef.current.getYjsSnapshot())}>导出快照</button><button type="button" onClick={() => tableRef.current && downloadJson('colwork.update-log.json', tableRef.current.getYjsUpdateLog())}>导出更新日志</button></div>
    <div ref={tableRoot} />
    <div className="log-toolbar"><div className="log-filters"><button className={`log-playback ${recording ? 'is-recording' : ''}`} type="button" aria-label={recording ? '暂停日志记录' : '继续日志记录'} onClick={() => { recordingRef.current = !recordingRef.current; setRecording(recordingRef.current) }}>{recording ? 'Ⅱ' : '▶'}</button>{logTypes.map((type) => <button className={`log-filter log-filter-${type} ${activeTypes.has(type) ? 'active' : ''}`} type="button" onClick={() => toggleType(type)} key={type}>{type}</button>)}</div><button className="log-clear" type="button" aria-label="清空日志" onClick={() => { setLogs([]); stickToBottom.current = true }}>×</button></div>
    <div ref={logRoot} className="log-window" role="log" onScroll={() => { if (logRoot.current) stickToBottom.current = logRoot.current.scrollHeight - logRoot.current.scrollTop - logRoot.current.clientHeight < 8 }}>{logs.filter((log) => activeTypes.has(log.type)).map((log, index) => { const formatted = formatLog(log.text); return <div className={`log-entry log-${log.type}`} key={`${log.text}-${index}`}><span className="log-kind">{log.type}</span>{formatted.json ? <details className="log-json-block"><summary>{textNodes(formatted.prefix)}</summary>{jsonNode(formatted.value)}</details> : <div className="log-body">{textNodes(formatted.prefix)}</div>}</div> })}</div>
  </section></main>
}

createRoot(document.getElementById('app')!).render(<App />)
