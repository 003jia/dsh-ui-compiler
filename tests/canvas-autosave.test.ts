import assert from 'node:assert/strict'
import test from 'node:test'

const { createCompilerAutosave } = await import(new URL('../dsh-entry/canvas-autosave.mjs', import.meta.url).href)

function editor() {
  let time = 0, timerId = 0
  const timers = new Map<number, {at: number; fn: () => void}>()
  let phase = 'ready', dirty = false, recovery = false
  let revision = 0, generation = 1
  const writes: {generation: number; revision: number}[] = []
  let pending: Promise<boolean> | undefined
  let finish: (success: boolean) => void
  const save = () => {
    if (pending) return pending
    const snapshot = {generation,revision}
    writes.push(snapshot)
    phase = 'saving'
    pending = new Promise(resolve => {
      finish = success => {
        pending = undefined
        if (success) dirty = autosave.committed(snapshot)
        phase = success ? 'ready' : 'error'
        if (success) autosave.ready()
        resolve(success)
      }
    })
    return pending
  }
  const autosave = createCompilerAutosave(() => ({dirty, phase, recovery, pending}), save, {
    setTimeout(fn: () => void, delay: number) { timers.set(++timerId,{at:time+delay,fn}); return timerId },
    clearTimeout(id: number) { timers.delete(id) },
  }, () => time)
  function notify(d: boolean, r: number, g: number) {
    const next = autosave.changed({dirty:d,revision:r,generation:g})
    if (next !== undefined) dirty = next
  }
  return {
    edit() { notify(true, ++revision, generation) },
    newGeneration() { generation++; revision = 0; notify(true,revision,generation) },
    notify, save, writes, autosave, dirty: () => dirty,
    finish(success: boolean) { finish(success) },
    recovery(value: boolean) { recovery = value },
    advance(ms: number) {
      time += ms
      for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn() }
    },
  }
}

test('project canvas debounces consecutive changes and periodically checkpoints a long edit', () => {
  const doc = editor()
  doc.edit(); doc.advance(500); doc.edit(); doc.advance(899)
  assert.equal(doc.writes.length, 0)
  doc.advance(1)
  assert.deepEqual(doc.writes,[{generation:1,revision:2}])
  doc.finish(true)
  for (let i=0;i<10;i++) { doc.edit(); doc.advance(500) }
  assert.deepEqual(doc.writes.at(-1),{generation:1,revision:12})
  doc.finish(true)
  assert.equal(doc.dirty(),false)
})

test('an edit during a manual save survives its acknowledgement and navigation flushes the latest snapshot', async () => {
  const doc = editor()
  doc.edit(); void doc.save(); doc.newGeneration()
  const flushing = doc.autosave.flush()
  doc.finish(true)
  await Promise.resolve()
  assert.equal(doc.dirty(),true)
  assert.deepEqual(doc.writes,[{generation:1,revision:1},{generation:2,revision:0}])
  doc.notify(false,1,1) // a delayed clean notification from the previous generation
  assert.equal(doc.dirty(),true)
  doc.finish(true)
  assert.equal(await flushing,true)
  doc.notify(true,0,2) // an old dirty event after the write
  doc.advance(5000)
  assert.equal(doc.dirty(),false)
  assert.equal(doc.writes.length,2)
})

test('failed writes leave the canvas dirty and require a retry instead of looping', async () => {
  const doc = editor()
  doc.edit(); doc.advance(900); doc.finish(false)
  doc.edit(); doc.advance(5000)
  assert.equal(doc.dirty(),true)
  assert.equal(await doc.autosave.flush(),false)
  assert.equal(doc.writes.length,1)
  void doc.save(); doc.finish(true)
  assert.equal(doc.dirty(),false)
})

test('unconfirmed recovery, a conflict, or detaching the project cancels automatic writes', async () => {
  const doc = editor()
  doc.recovery(true); doc.edit(); doc.advance(900)
  assert.equal(await doc.autosave.flush(),false)
  assert.equal(doc.writes.length,0)
  doc.recovery(false); doc.edit()
  const before = doc.autosave.conflicts
  doc.autosave.conflict()
  assert.notEqual(doc.autosave.conflicts, before)
  doc.advance(900)
  assert.equal(doc.writes.length,0)
  doc.edit(); doc.autosave.dispose(); doc.advance(900)
  assert.equal(await doc.autosave.flush(),false)
  assert.equal(doc.writes.length,0)
})
