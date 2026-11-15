import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { ColworkImageRef } from './cellImage'
import type { ColworkVersionHistory } from './versionHistory'

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
  versionHistory?: ColworkVersionHistory
  /** Stable, user-specific key for saving personal views in this browser. */
  personalViewKey?: string
  /** Keep the exportable in-memory update log. Defaults off when a history adapter is registered. */
  recordUpdateLog?: boolean
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
  websocketChunks?: never
  peerOpts?: never
}
export type BuiltInCollaborationOptions = CommonOptions & {
  room: string
  transport?: 'webrtc' | 'websocket'
  collaboration?: never
  sheetId?: never
  signalingUrl?: string
  websocketUrl?: string
  /** Enable chunked sync when connected to the Colwork Cloudflare worker. */
  websocketChunks?: boolean
  peerOpts?: Record<string, unknown>
  initializeAfterSync?: boolean
  rows?: string[][]
  snapshot?: Uint8Array
  updates?: Uint8Array[]
}
export type ColworkTableOptions = ExternalCollaborationOptions | BuiltInCollaborationOptions
