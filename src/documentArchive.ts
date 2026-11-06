import type { Awareness } from 'y-protocols/awareness'
import { bytesToBase64, type YjsUpdateRecord, type YjsSnapshotFile, type YjsUpdateLogFile } from './yjsArchive'
import { exportYjsSnapshot } from './model'
import type { SheetDocument } from './sheetDocument'

export class DocumentArchive {
  revision = 0
  private sequence = 0
  private readonly updates: YjsUpdateRecord[] = []
  private readonly loggedPeers = new Set<object>()
  private readonly loggedSignals = new Set<object>()
  constructor(private readonly sheet: SheetDocument, private readonly awareness: Awareness, private readonly provider: unknown, private readonly room: string | undefined, private readonly log: (message: string) => void, private readonly logging: boolean) {
    sheet.doc.on('update', this.onUpdate)
    awareness.on('update', this.onAwarenessUpdate)
  }
  private readonly onUpdate = (update: Uint8Array, origin: unknown) => {
    this.revision++
    this.updates.push({ seq: ++this.sequence, update: bytesToBase64(update), timestamp: Date.now() })
    if (!this.logging) return
    const internal = this.provider as { room?: unknown } | undefined
    this.logChunk(`yjs:${origin === internal?.room ? 'recv' : 'send'}`, update)
    const { cells, rowHeights, columnWidths, merges } = this.sheet
    this.log(`yjs:state ${JSON.stringify({ cells: [...cells], rowHeights: [...rowHeights], columnWidths: [...columnWidths], merges: [...merges] })}`)
  }
  private readonly onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (!this.logging) return
    const internal = this.provider as { room?: unknown } | undefined
    this.log(`awareness:${origin === internal?.room ? 'recv' : 'send'} added=${added.join(',')} updated=${updated.join(',')} removed=${removed.join(',')}`)
    this.log(`awareness:state ${JSON.stringify([...this.awareness.getStates()])}`)
  }
  snapshot(): YjsSnapshotFile { return exportYjsSnapshot(this.sheet.doc, { room: this.room, sequence: this.sequence }) }
  updateLog(): YjsUpdateLogFile { return { format: 'colwork.update-log', version: 1, room: this.room, updates: this.updates.map(record => ({ ...record })) } }
  destroy() {
    this.sheet.doc.off('update', this.onUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
  }
  logChunk(label: string, data: Uint8Array) {
    const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
    this.log(`${label} bytes=${data.byteLength} hex=${hex}`)
  }

  inspectConnections() {
    if (!this.logging) return
    const internal = this.provider as unknown as {
      signalingConns?: Array<{ send: (message: unknown) => void; on: (event: string, callback: (message: unknown) => void) => void }>
      room?: { webrtcConns: Map<string, { peer: { send: (data: Uint8Array) => void; on: (event: string, callback: (data: Uint8Array) => void) => void } }> }
    }
    internal.signalingConns?.forEach((connection) => {
      if (this.loggedSignals.has(connection)) return
      this.loggedSignals.add(connection)
      const send = connection.send.bind(connection)
      connection.send = (message) => {
        this.log(`signal:send ${JSON.stringify(message)}`)
        send(message)
      }
      connection.on('message', (message) => this.log(`signal:recv ${JSON.stringify(message)}`))
      connection.on('connect', () => this.log('signal:connect'))
      connection.on('disconnect', () => this.log('signal:disconnect'))
      connection.on('error', (error) => this.log(`signal:error ${String(error)}`))
    })
    internal.room?.webrtcConns.forEach((connection, peerId) => {
      const peer = connection.peer
      if (this.loggedPeers.has(peer)) return
      this.loggedPeers.add(peer)
      const send = peer.send.bind(peer)
      peer.send = (data) => {
        this.logChunk(`webrtc:send peer=${peerId}`, data)
        send(data)
      }
      peer.on('data', (data) => this.logChunk(`webrtc:recv peer=${peerId}`, data))
      peer.on('connect', () => this.log(`webrtc:connect peer=${peerId}`))
      peer.on('close', () => this.log(`webrtc:close peer=${peerId}`))
      peer.on('error', (error) => this.log(`webrtc:error peer=${peerId} ${String(error)}`))
    })
  }
}
