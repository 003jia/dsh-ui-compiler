import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetDataUrl, findAsset, normalizeDirectory, readProjectConfig, saveAsset, writeProjectConfig,
} from '../dsh-entry/asset-store.mjs'

test('project folders stay relative and reject escapes', () => {
  assert.equal(normalizeDirectory(undefined, 'design/pages'), 'design/pages')
  assert.equal(normalizeDirectory(' drafts/ui ', 'design/pages'), 'drafts/ui')
  for (const bad of ['/tmp/x', '../x', 'a/../b', 'a//b', '', 'a\\b']) {
    assert.throws(() => normalizeDirectory(bad, 'design/pages'))
  }
})

test('configuration round-trips and defaults when absent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uic-assets-')))
  try {
    const defaults = await readProjectConfig(root)
    assert.deepEqual(defaults, { designDir: 'design/pages', assetDir: 'design/assets', configured: false })
    const saved = await writeProjectConfig(root, { designDir: 'drafts', assetDir: 'files' })
    assert.deepEqual(saved, { designDir: 'drafts', assetDir: 'files' })
    const read = await readProjectConfig(root)
    assert.equal(read.designDir, 'drafts')
    assert.equal(read.assetDir, 'files')
    assert.equal(read.configured, true)
    await mkdir(join(root, '.dsh', 'ui-compiler'), { recursive: true })
    await writeFile(join(root, '.dsh', 'ui-compiler', 'config.json'), '{oops')
    await assert.rejects(readProjectConfig(root), /not valid JSON/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assets are content-addressed, deduplicated and readable by id', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uic-assets-')))
  try {
    const bytes = Buffer.from('hello asset')
    const first = await saveAsset(root, 'design/assets', { name: 'note "one".txt', mimeType: 'text/plain', bytes })
    assert.match(first.id, /^[a-f0-9]{64}$/)
    assert.ok(first.path.startsWith('design/assets/'))
    assert.ok(first.path.endsWith('-note "one".txt'))
    const stored = await readFile(join(root, first.path))
    assert.deepEqual(stored, bytes)
    const second = await saveAsset(root, 'design/assets', { name: 'other.txt', mimeType: 'text/plain', bytes })
    assert.equal(second.id, first.id)
    const found = await findAsset(root, 'design/assets', first.id)
    assert.equal(found?.mimeType, 'text/plain')
    assert.deepEqual(found?.bytes, bytes)
    assert.equal(await findAsset(root, 'design/assets', 'f'.repeat(64)), undefined)
    await assert.rejects(findAsset(root, 'design/assets', '../x'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('image data URLs are bounded and typed', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  assert.match(assetDataUrl('image/png', png)!, /^data:image\/png;base64,/)
  assert.equal(assetDataUrl('text/plain', png), undefined)
})
