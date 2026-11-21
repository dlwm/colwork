import type * as Y from 'yjs'
import { readWorkbookSnapshotUpdate, restoreWorkbookVersion, type ColworkVersion, type ColworkVersionHistory, type YjsSnapshotFile } from '../src/index'

const retention = 12

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error)
  })
}

export function demoVersionHistory(document: Y.Doc): ColworkVersionHistory {
  let connection: Promise<IDBDatabase> | undefined
  const open = () => connection ??= (() => {
    const database = indexedDB.open('colwork-workbook-versions', 1)
    database.onupgradeneeded = () => {
      database.result.createObjectStore('versions', { keyPath: 'id' })
      database.result.createObjectStore('snapshots')
    }
    return request(database)
  })()
  const all = (store: IDBObjectStore) => request<ColworkVersion[]>(store.getAll()).then(versions =>
    versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)))
  const load = async (id: string, signal: AbortSignal) => {
    const db = await open()
    const snapshot: YjsSnapshotFile | undefined = await request(db.transaction('snapshots').objectStore('snapshots').get(id))
    signal.throwIfAborted()
    if (!snapshot) throw new Error('版本不存在')
    return Uint8Array.from(atob(snapshot.snapshot), character => character.charCodeAt(0))
  }
  return {
    documentId: 'local-workbook-demo',
    captureClientSnapshot: true,
    async list({ signal }) {
      signal.throwIfAborted()
      const db = await open()
      const versions = await all(db.transaction('versions').objectStore('versions'))
      signal.throwIfAborted()
      return { versions }
    },
    async create({ label, snapshot, signal }) {
      if (!snapshot || snapshot.snapshot.length > 6 * 1024 * 1024) throw new Error('本机演示无法保存此大小的版本')
      const db = await open()
      signal.throwIfAborted()
      const transaction = db.transaction(['versions', 'snapshots'], 'readwrite')
      const completed = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
      // Date and UUID together also give a deterministic order during pruning.
      const createdAt = new Date().toISOString()
      const version = { id: `${createdAt}/${crypto.randomUUID()}`, createdAt, label, author: '本机演示' }
      const store = transaction.objectStore('versions')
      const snapshots = transaction.objectStore('snapshots')
      const query = store.getAllKeys()
      query.onsuccess = () => {
        if (signal.aborted) { transaction.abort(); return }
        for (const id of query.result.reverse().slice(retention - 1)) {
          store.delete(id)
          snapshots.delete(id)
        }
        store.put(version)
        snapshots.put(snapshot, version.id)
      }
      await completed
      return version
    },
    async read({ versionId, signal }) {
      return readWorkbookSnapshotUpdate(await load(versionId, signal))
    },
    async restore({ versionId, signal }) {
      restoreWorkbookVersion(document, await load(versionId, signal))
    },
  }
}
