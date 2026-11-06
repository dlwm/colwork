import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export type EditingState = { editing: boolean; dirty: boolean }

type CommonOptions = {
  user: string
  userColor?: string
  rowCount?: number
  columnCount?: number
  onLog?: (message: string) => void
  readOnly?: boolean
  onEditingChange?: (state: EditingState) => void
}
export type ExternalCollaborationOptions = CommonOptions & {
  transport: 'external'
  collaboration: { document: Y.Doc; awareness: Awareness }
  room?: string
  rows?: never
  snapshot?: never
  updates?: never
  initializeAfterSync?: false
  signalingUrl?: never
  websocketUrl?: never
  peerOpts?: never
}
export type BuiltInCollaborationOptions = CommonOptions & {
  room: string
  transport?: 'webrtc' | 'websocket'
  collaboration?: never
  signalingUrl?: string
  websocketUrl?: string
  peerOpts?: Record<string, unknown>
  initializeAfterSync?: boolean
  rows?: string[][]
  snapshot?: Uint8Array
  updates?: Uint8Array[]
}
export type ColworkTableOptions = ExternalCollaborationOptions | BuiltInCollaborationOptions
