import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { ColworkImageRef } from './cellImage'

export type ColworkImageOptions = {
  upload?: (file: File) => Promise<ColworkImageRef>
  resolveUrl: (id: string) => string | undefined
}

export type EditingState = { editing: boolean; dirty: boolean }
export type ColworkRowView = {
  sort?: { column: number; direction: 'asc' | 'desc' }
  filters?: Array<{ column: number; contains: string }>
  headerRows?: number
}

/** Host-supplied rules for this viewer's table instance. */
export type ColworkViewPolicy = {
  watermark?: { viewerText?: string; fixedText?: string }
  allowExport?: boolean
}

type CommonOptions = {
  user: string
  userColor?: string
  rowCount?: number
  columnCount?: number
  onLog?: (message: string) => void
  readOnly?: boolean
  viewPolicy?: ColworkViewPolicy
  images?: ColworkImageOptions
  onEditingChange?: (state: EditingState) => void
}
export type ExternalCollaborationOptions = CommonOptions & {
  transport: 'external'
  collaboration: { document: Y.Doc; awareness: Awareness }
  sheetId?: string
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
  sheetId?: never
  signalingUrl?: string
  websocketUrl?: string
  peerOpts?: Record<string, unknown>
  initializeAfterSync?: boolean
  rows?: string[][]
  snapshot?: Uint8Array
  updates?: Uint8Array[]
}
export type ColworkTableOptions = ExternalCollaborationOptions | BuiltInCollaborationOptions
