import type * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { waitForColworkSync } from './colworkWebSocket'

export type ColworkConnectionState = 'disconnected' | 'connecting' | 'connected'
export type ColworkSaveReceipt = Readonly<{ throughRevision: number; confirmedAt: number }>
export type ColworkSaveState = Readonly<{
  connection: ColworkConnectionState
  synced: boolean
  localRevision: number
  persistence: 'unknown' | 'pending' | 'saving' | 'saved' | 'error'
  receipt?: ColworkSaveReceipt
  error?: unknown
}>
export type ColworkSaveTrackerOptions = {
  /** Defaults to local Yjs transactions. A host can include updates it applies as imports. */
  isLocalUpdate?: (transaction: Y.Transaction) => boolean
}
export type ColworkSaveConfirmation = (request: {
  throughRevision: number
  signal: AbortSignal
}) => Promise<void>

/** Tracks local Yjs changes and confirmations explicitly requested by the host. */
export class ColworkSaveTracker {
  private localRevision = 0
  private connection: ColworkConnectionState = 'disconnected'
  private synced = false
  private receipt?: ColworkSaveReceipt
  private failure?: { revision: number; error: unknown }
  private readonly pending = new Map<AbortController, number>()
  private readonly listeners = new Set<(state: ColworkSaveState) => void>()
  private scheduled = false
  private destroyed = false

  constructor(private readonly document: Y.Doc, private readonly options: ColworkSaveTrackerOptions = {}) {
    document.on('update', this.onUpdate)
  }

  private readonly onUpdate = (_update: Uint8Array, _origin: unknown, _document: Y.Doc, transaction: Y.Transaction) => {
    if (!(this.options.isLocalUpdate?.(transaction) ?? transaction.local)) return
    this.localRevision++
    this.failure = undefined
    this.notify()
  }

  setConnection(connection: ColworkConnectionState, synced = false) {
    const ready = connection === 'connected' && synced
    if (this.destroyed || (connection === this.connection && ready === this.synced)) return
    this.connection = connection
    this.synced = ready
    this.notify()
  }

  getState(): ColworkSaveState {
    const { localRevision, receipt } = this
    const confirmed = receipt?.throughRevision === localRevision
    const failure = !confirmed && this.failure?.revision === localRevision ? this.failure : undefined
    const confirming = !confirmed && [...this.pending.values()].includes(localRevision)
    return {
      connection: this.connection, synced: this.synced, localRevision, receipt,
      persistence: confirmed ? 'saved' : confirming ? 'saving' : failure ? 'error' : localRevision ? 'pending' : 'unknown',
      ...(failure && !confirming ? { error: failure.error } : {}),
    }
  }

  subscribe(listener: (state: ColworkSaveState) => void): () => void {
    if (this.destroyed) return () => {}
    this.listeners.add(listener)
    listener(this.getState())
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    if (this.scheduled || !this.listeners.size) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const state = this.getState()
      this.listeners.forEach(listener => listener(state))
    })
  }

  /** Confirmations cover edits already observed when this call starts. */
  async confirmSaved(confirm: ColworkSaveConfirmation, signal?: AbortSignal): Promise<ColworkSaveReceipt> {
    if (this.destroyed) throw new Error('保存状态已关闭')
    if (signal?.aborted) throw signal.reason
    const throughRevision = this.localRevision
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    this.pending.set(controller, throughRevision)
    this.notify()
    signal?.addEventListener('abort', cancel, { once: true })
    let rejectAbort: (reason: unknown) => void = () => {}
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return confirm({ throughRevision, signal: controller.signal })
      })
      await Promise.race([result, interrupted])
      if (controller.signal.aborted) throw controller.signal.reason
      const receipt = Object.freeze({ throughRevision, confirmedAt: Date.now() })
      if (throughRevision >= (this.receipt?.throughRevision ?? -1)) this.receipt = receipt
      return receipt
    } catch (error) {
      if (!controller.signal.aborted && throughRevision === this.localRevision) this.failure = { revision: throughRevision, error }
      throw error
    } finally {
      this.pending.delete(controller)
      controller.signal.removeEventListener('abort', onAbort)
      signal?.removeEventListener('abort', cancel)
      this.notify()
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.document.off('update', this.onUpdate)
    this.listeners.clear()
    this.pending.forEach((_, controller) => controller.abort())
  }
}

/** Adapts a y-websocket provider using createColworkWebSocket() against Colwork's Worker. */
export function trackColworkWorkerSave(provider: WebsocketProvider, options?: ColworkSaveTrackerOptions) {
  const tracker = new ColworkSaveTracker(provider.doc, options)
  const updateConnection = () => tracker.setConnection(
    provider.wsconnected ? 'connected' : provider.wsconnecting ? 'connecting' : 'disconnected', provider.synced,
  )
  const onClose = () => queueMicrotask(updateConnection)
  provider.on('status', updateConnection)
  provider.on('sync', updateConnection)
  provider.on('connection-close', onClose)
  updateConnection()
  return {
    getState: () => tracker.getState(),
    subscribe: (listener: (state: ColworkSaveState) => void) => tracker.subscribe(listener),
    confirmSaved: (signal?: AbortSignal) => tracker.confirmSaved(({ signal }) => {
      const socket = provider.ws
      if (!provider.wsconnected || !provider.synced || !socket) throw new Error('等待协作同步完成后再确认落库')
      return waitForColworkSync(socket, signal)
    }, signal),
    destroy() {
      provider.off('status', updateConnection)
      provider.off('sync', updateConnection)
      provider.off('connection-close', onClose)
      tracker.destroy()
    },
  }
}
