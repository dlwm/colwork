import { WebsocketProvider } from 'y-websocket'
import type { CollaborationSession } from './collaboration'
import type { ColworkTableOptions } from './options'
import type { SheetDocument } from './sheetDocument'
import { defaultRows, seedDemoFormatting } from './demoData'
type SyncHost = { canEdit(): boolean; log(message: string): void; inspect(): void; clearHistory(): void; render(): void }

export function bindBuiltInSynchronization(session: CollaborationSession, options: ColworkTableOptions, sheet: SheetDocument, shouldSeed: boolean, host: SyncHost) {
  const provider = session.provider
  if (!provider || options.transport === 'external') return
  if (provider instanceof WebsocketProvider) {
    provider.on('status', ({ status }: { status: string }) => host.log(status === 'connected' ? 'signaling:connected' : 'signaling:disconnected'))
    provider.on('sync', (synced: boolean) => {
      host.log(synced ? 'synced' : 'syncing')
      if (!synced || !options.initializeAfterSync) return
      const metadata = sheet.doc.getMap<boolean>('colwork-metadata')
      if (host.canEdit() && !metadata.get('initialized')) {
        sheet.doc.transact(() => {
          if (shouldSeed && sheet.cells.size === 0 && sheet.locks.size === 0) {
            sheet.seed(options.rows ?? defaultRows)
            seedDemoFormatting(sheet)
          }
          metadata.set('initialized', true)
        })
        host.clearHistory()
      }
      host.render()
    })
    if (options.initializeAfterSync) provider.connect()
    return
  }
  provider.on('status', ({ connected }: { connected: boolean }) => {
    host.log(connected ? 'signaling:connected' : 'signaling:disconnected')
    host.inspect()
  })
  provider.on('synced', ({ synced }: { synced: boolean }) => host.log(synced ? 'synced' : 'syncing'))
  provider.on('peers', ({ added, removed, webrtcPeers }: { added: string[]; removed: string[]; webrtcPeers: unknown[] }) => {
    if (added.length) host.log(`peer:+${added.length}`)
    if (removed.length) host.log(`peer:-${removed.length}`)
    host.log(`webrtc:${webrtcPeers.length}`)
    host.inspect()
  })
}
