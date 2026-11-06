import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { WebrtcProvider } from 'y-webrtc'
import { WebsocketProvider } from 'y-websocket'
import type { ColworkTableOptions } from './options'

const activePublishers = new WeakMap<Awareness, CollaborationSession>()
const defaultIceServers = ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'].map(urls => ({ urls }))

/** Owns built-in resources, or borrows an entire host-managed collaboration session. */
export class CollaborationSession {
  readonly document: Y.Doc
  readonly awareness: Awareness
  readonly provider?: WebrtcProvider | WebsocketProvider
  readonly external: boolean
  private destroyed = false
  private published: Record<string, unknown> = {}

  constructor(options: ColworkTableOptions) {
    this.external = options.transport === 'external'
    if (options.transport === 'external') {
      if (!options.collaboration?.document || !options.collaboration.awareness) throw new TypeError('External collaboration requires a document and awareness')
      if (options.collaboration.awareness.doc !== options.collaboration.document) throw new TypeError('Awareness must belong to the supplied document')
      if (options.rows !== undefined || options.snapshot !== undefined || options.updates !== undefined || (options.initializeAfterSync as boolean | undefined) === true) {
        throw new TypeError('Initialize external documents through the model API before creating a table')
      }
      this.document = options.collaboration.document
      this.awareness = options.collaboration.awareness
    } else {
      if (typeof options.room !== 'string') throw new TypeError('Built-in collaboration requires a room')
      this.document = new Y.Doc()
      try {
        if (options.readOnly) this.awareness = new Awareness(this.document)
        else if (options.transport === 'webrtc') {
          this.provider = new WebrtcProvider(options.room, this.document, {
            signaling: [options.signalingUrl ?? 'ws://127.0.0.1:4444'], filterBcConns: false,
            peerOpts: options.peerOpts ?? { config: { iceServers: defaultIceServers } },
          })
          this.awareness = this.provider.awareness
        } else {
          const url = new URL(options.websocketUrl ?? 'ws://127.0.0.1:1234')
          const params = Object.fromEntries(url.searchParams)
          url.search = ''
          this.provider = new WebsocketProvider(url.toString().replace(/\/$/, ''), encodeURIComponent(options.room), this.document, { params, connect: !options.initializeAfterSync })
          this.awareness = this.provider.awareness
        }
        if (options.snapshot) Y.applyUpdate(this.document, options.snapshot)
        options.updates?.forEach(update => Y.applyUpdate(this.document, update))
      } catch (error) {
        this.provider?.destroy()
        this.document.destroy()
        throw error
      }
    }
    const local = this.awareness.getLocalState()
    if (local !== null && local.user === undefined) {
      this.awareness.setLocalStateField('user', { name: options.user, color: options.userColor })
    }
  }

  publish(fields: Record<string, unknown>) {
    if (this.destroyed) return
    const state = this.awareness.getLocalState()
    // A host can intentionally remove its presence while keeping the document open.
    if (state === null) return
    this.published = { ...this.published, ...fields }
    activePublishers.set(this.awareness, this)
    this.awareness.setLocalState({ ...state, ...fields })
  }

  finishEditing() {
    if (activePublishers.get(this.awareness) !== this) return
    if (this.awareness.getLocalState()?.editing !== this.published.editing) return
    this.publish({ editing: null })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.external) {
      this.provider?.destroy()
      this.awareness.destroy()
      this.document.destroy()
      return
    }
    if (activePublishers.get(this.awareness) !== this) return
    activePublishers.delete(this.awareness)
    const state = this.awareness.getLocalState()
    if (state === null) return
    const next = { ...state }
    let changed = false
    for (const field of ['selection', 'cursor', 'editing']) {
      if (field in this.published && next[field] === this.published[field]) {
        delete next[field]
        changed = true
      }
    }
    if (changed) this.awareness.setLocalState(next)
  }
}
