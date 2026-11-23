import test from 'node:test'
import assert from 'node:assert/strict'

const { createCompilerSelectionBridge, patchCompilerSelectionGlue } =
  await import(new URL('../dsh-entry/selection-bridge.mjs', import.meta.url).href)

function shell() {
  const events = new Map<string, (arg?: any) => void>()
  const timers = new Map<number, () => void>()
  const replies: { body: any, origin: string }[] = []
  let nextTimer = 0
  const frame = {
    parent: { postMessage(body: unknown, origin: string) { replies.push({ body, origin }) } },
    location: new URL('http://127.0.0.1:10001/?embed=vscode'),
    addEventListener(type: string, listener: (arg?: any) => void) { events.set(type, listener) },
    setTimeout(callback: () => void, ms: number) {
      assert.ok(ms > 400); timers.set(++nextTimer, callback); return nextTimer
    },
    clearTimeout(id: number) { timers.delete(id) },
  }
  const bridge = createCompilerSelectionBridge(frame)
  function message(data: any, origin = 'dsh-app://app', source: any = frame.parent) {
    events.get('message')!({ data, origin, source })
  }
  function tick() {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
  }
  function sample(selectedIds: string[], activePageId: string | null, url = '/api/mcp/selection') {
    const xhr = {}
    bridge.opened(xhr, 'POST', url)
    if (bridge.tracks(xhr)) bridge.sent(xhr, JSON.stringify({ selectedIds, activePageId }))
  }
  const request = { type: 'uic/selection-request', requestId: 'uic.1' }
  const init = JSON.stringify({ type: 'op-bridge/init', token: 'test' })
  return { events, frame, message, tick, sample, replies, bridge, request, init }
}

test('managed frame returns the newest outgoing native selection even after a later document push resets the daemon', () => {
  const s = shell()
  s.message(s.init)
  s.message(s.request)
  s.sample(['layer'], null)
  // The large document is not a selection, and never handed to the observer.
  const docPost = {}
  s.bridge.opened(docPost, 'POST', '/api/mcp/document')
  assert.equal(s.bridge.tracks(docPost), false)
  s.tick()
  assert.deepEqual(s.replies, [{ body: { type: 'uic/selection-result', requestId: 'uic.1',
    selectedIds: ['layer'], activePageId: null }, origin: 'dsh-app://app' }])
  s.message(s.request)
  s.sample([], 'page-2')
  s.tick()
  assert.deepEqual(s.replies.at(-1)?.body.selectedIds, [])
  assert.equal(s.replies.at(-1)?.body.activePageId, 'page-2')
})

test('unknown selection, explicit clear and document replacement stay distinct', () => {
  const s = shell()
  s.message(s.init)
  s.sample(['wrong-origin'], null, 'https://other.test/api/mcp/selection')
  s.message(s.request); s.tick()
  assert.equal(s.replies[0].body.selectedIds, null)
  s.sample(['old'], 'page1')
  s.message(s.request)
  s.message(JSON.stringify({ type: 'op-bridge/open-document', json: '{}' }))
  s.tick()
  assert.equal(s.replies.length, 1)
  s.message(s.request); s.tick()
  assert.equal(s.replies[1].body.selectedIds, null)
})

test('only the initialized frame parent can request; standalone contexts remain inactive', () => {
  const s = shell()
  s.message(s.request)
  s.message(s.init, 'dsh-app://app', {})
  s.message(s.init, 'null')
  s.message(s.request); s.tick()
  assert.equal(s.replies.length, 0)
  s.message(s.init)
  s.message(s.request, 'https://other.test')
  s.message(s.request, 'dsh-app://app', {}); s.tick()
  assert.equal(s.replies.length, 0)
  assert.equal(createCompilerSelectionBridge(null), null)
  assert.equal(createCompilerSelectionBridge({ ...s.frame, location: new URL('http://localhost/') }), null)
  assert.throws(() => patchCompilerSelectionGlue('upstream changed'), /Unexpected/)
})
