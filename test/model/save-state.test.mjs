import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { ColworkSaveTracker } from '../../dist/colwork.js'

test('connection and initial sync do not confirm local changes, and late receipts cover only their revisions', async () => {
  const document = new Y.Doc()
  const tracker = new ColworkSaveTracker(document)
  const seen = []
  const unsubscribe = tracker.subscribe(state => seen.push(state))
  let finish
  try {
    tracker.setConnection('connected', true)
    assert.equal(tracker.getState().persistence, 'unknown')
    document.getMap('cells').set('0:0', 'first')
    assert.equal(tracker.getState().persistence, 'pending')
    const first = tracker.confirmSaved(({ throughRevision }) => {
      assert.equal(throughRevision, 1)
      return new Promise(resolve => { finish = resolve })
    })
    assert.equal(tracker.getState().persistence, 'saving')
    await Promise.resolve()
    document.getMap('cells').set('0:0', 'second')
    assert.equal(tracker.getState().persistence, 'pending')
    finish()
    assert.equal((await first).throughRevision, 1)
    assert.equal(tracker.getState().persistence, 'pending')
    const receipt = await tracker.confirmSaved(async () => {})
    assert.equal(receipt.throughRevision, 2)
    assert.equal(tracker.getState().persistence, 'saved')
    tracker.setConnection('disconnected', true)
    assert.equal(tracker.getState().synced, false)
    assert.equal(tracker.getState().persistence, 'saved')
    assert.equal(seen.at(-1).persistence, 'saved')
  } finally { unsubscribe(); tracker.destroy(); document.destroy() }
})

test('hosts can count staged local imports and retry a failed or canceled confirmation', async () => {
  const document = new Y.Doc()
  const peer = new Y.Doc()
  const importOrigin = Symbol('import')
  const tracker = new ColworkSaveTracker(document, { isLocalUpdate: t => t.local || t.origin === importOrigin })
  try {
    peer.getMap('cells').set('0:0', 'remote')
    Y.applyUpdate(document, Y.encodeStateAsUpdate(peer))
    assert.equal(tracker.getState().localRevision, 0)
    const prior = Y.encodeStateVector(peer)
    peer.getMap('cells').set('1:0', 'local import')
    Y.applyUpdate(document, Y.encodeStateAsUpdate(peer, prior), importOrigin)
    assert.equal(tracker.getState().localRevision, 1)
    const error = new Error('store unavailable')
    await assert.rejects(tracker.confirmSaved(async () => { throw error }), error)
    assert.equal(tracker.getState().persistence, 'error')
    assert.equal(tracker.getState().error, error)
    const cancel = new AbortController()
    const confirmation = tracker.confirmSaved(() => new Promise(() => {}), cancel.signal)
    cancel.abort()
    await assert.rejects(confirmation, { name: 'AbortError' })
    assert.equal(tracker.getState().receipt, undefined)
    assert.equal((await tracker.confirmSaved(async () => {})).throughRevision, 1)
    assert.equal(tracker.getState().persistence, 'saved')
  } finally { tracker.destroy(); document.destroy(); peer.destroy() }
})
