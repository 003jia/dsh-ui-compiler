import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { stageSelectionBundle, patchCompilerSelectionLaunch, patchCompilerEditorProcess } =
  await import(new URL('../dsh-entry/selection-runtime.mjs', import.meta.url).href)

test('publishes a complete canvas-only bundle for concurrent opens and separates builds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-web-bundle-'))
  try {
    const original = join(root, 'original')
    const config = join(root, 'cache')
    await mkdir(join(original, 'assets'), { recursive: true })
    await writeFile(join(original, 'op_host_web.js'), 'original')
    await writeFile(join(original, 'op_host_web_bg.wasm'), 'wasm')
    await writeFile(join(original, 'assets', 'icon'), 'icon')
    const builds = await Promise.all(Array.from({ length: 4 }, () => stageSelectionBundle(original, config, 'first')))
    assert.equal(new Set(builds).size, 1)
    const [view] = builds
    assert.equal(await readFile(join(view, 'assets', 'icon'), 'utf8'), 'icon')
    assert.equal(await readFile(join(view, 'op_host_web_bg.wasm'), 'utf8'), 'wasm')
    assert.equal(await readFile(join(view, 'op_host_web.js'), 'utf8'), 'first')
    assert.equal(await readFile(join(original, 'op_host_web.js'), 'utf8'), 'original')
    const later = await stageSelectionBundle(original, config, 'updated')
    assert.notEqual(later, view)
    assert.equal(await readFile(join(view, 'op_host_web.js'), 'utf8'), 'first')
    assert.equal((await readdir(join(config, 'canvas-web-bundles'))).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordinary sessions and pipeline daemons retain the original bundle', () => {
  const source = 'const launch = await managedEditorProcessOptions(runtime, capability.sourcePath, origin);'
  assert.match(patchCompilerSelectionLaunch(source), /ownerSessionId\?\.startsWith\('uic-sidebar-'\) === true/)
  assert.throws(() => patchCompilerSelectionLaunch('unknown host'))
  assert.throws(() => patchCompilerEditorProcess('unknown process'))
})
