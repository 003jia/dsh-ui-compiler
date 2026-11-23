import assert from 'node:assert/strict'
import test from 'node:test'
const {createProjectFontReader, patchCompilerFontGlue} =
  await import(new URL('../dsh-entry/font-bridge.mjs', import.meta.url).href)

const file = { family: 'Noto Sans SC', url: '/pkg/uic-fonts/NotoSansSC-VF.ttf', aliases: ['$ed-font', '$sf-font'] }
const store = { name: 'imported_fonts', transaction: { db: { name: 'openpencil' }, mode: 'readonly' } }
function host(response: () => Response) {
  const fetched: string[] = []
  const frame = { parent: {}, location: new URL('http://127.0.0.1:8999/?embed=vscode'),
    fetch(url: string) { fetched.push(url); return Promise.resolve(response()) } }
  const reader = createProjectFontReader(frame, [file])
  const request = {}
  reader.track(store, request)
  return { reader, fetched, request }
}
const ttf = () => new Response(Uint8Array.from([0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7]))

test('load local TrueType once, share alias bytes, preserve the original IndexedDB records', async () => {
  const { reader, fetched, request } = host(ttf)
  await Promise.all([reader.prepare(), reader.prepare()])
  assert.deepEqual(fetched, [file.url])
  const stored: never[] = []
  const rows = reader.merge(request, stored)
  assert.deepEqual(rows.map((r: any) => r.family), ['Noto Sans SC', '$ed-font', '$sf-font'])
  assert.equal(rows[1].bytes, rows[0].bytes)
  assert.equal(rows[2].bytes, rows[0].bytes)
  assert.deepEqual(stored, [])
})

test('user imported family and overrides always win; unrelated reads are untouched', async () => {
  const { reader, request } = host(ttf)
  await reader.prepare()
  const real = Uint8Array.of(1, 2), override = Uint8Array.of(3)
  const rows = [{family: 'noto sans sc', bytes: real}, {family: '$sf-font', bytes: override}]
  assert.deepEqual(reader.merge(request, rows), [...rows, {family:'$ed-font', bytes:real}])
  for (const other of [{...store, name:'other'}, {...store, transaction:{...store.transaction, mode:'readwrite'}},
    {...store, transaction:{db:{name:'x'},mode:'readonly'}}]) {
    const unrelated = {}; reader.track(other, unrelated)
    assert.equal(reader.merge(unrelated, rows), rows)
  }
})
test('missing/invalid bytes cannot create a font entry; manifest disallows external font URLs', async () => {
  for (const response of [() => new Response('font not found', {status:404}), () => new Response('HTML'),
    () => new Response('bad', {headers:{'content-length':String(33*1024*1024)}})]) {
    const { reader, request } = host(response)
    await reader.prepare()
    assert.deepEqual(reader.merge(request, []),[])
  }
  assert.throws(() => patchCompilerFontGlue('',[{...file, url:'https://example.com/other.ttf'}]), /Unexpected project font/)
  assert.throws(() => patchCompilerFontGlue('different release',[file]), /version/)
})

test('one local fetch serves the CSS face and native rows and persisted faces keep priority', async () => {
  const seen: any[] = [], exclusions: string[] = []
  const frame = { parent: {}, location: new URL('http://127.0.0.1:8999/?embed=vscode'),
    fetch: async () => ttf() }
  const reader = createProjectFontReader(frame, [{ ...file, weight: '100 900' }], {
    registerProjectTypeface(...args: any[]) { seen.push(args); return Promise.resolve(true) },
    excludeProjectTypeface(name: string) { exclusions.push(name) },
  })
  await Promise.all([reader.prepare(), reader.prepare()])
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].slice(0, 2), ['Noto Sans SC', ['$ed-font', '$sf-font']])
  assert.equal(seen[0][3], '100 900')
  const request = {}; reader.track(store, request)
  const [added] = reader.merge(request, [])
  assert.equal(added.bytes, seen[0][2])
  assert.deepEqual(exclusions, [])
  const imported = [{ family: '$sf-font', bytes: Uint8Array.of(1) }]
  reader.merge(request, imported)
  assert.deepEqual(exclusions, ['$sf-font'])
})
