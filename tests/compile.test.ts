import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readOpDocument } from '../src/adapters/op/index.ts'
import { compileDesign } from '../src/compile.ts'
import { emitDshReact, type CompilerMap } from '../src/emit/dsh-react/index.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const design = join(projectRoot, 'tests/fixtures/settings.op')

test('renders the mapped design with reproducible JSX, CSS, dictionaries and diagnostics', () => {
  const mapping: CompilerMap = JSON.parse(readFileSync(join(projectRoot, 'ui-compiler.map.json'), 'utf8'))
  const page = readOpDocument(design, 'Settings')
  const output = emitDshReact(page, mapping, 'GoldenView')
  const expected = JSON.parse(readFileSync(join(projectRoot, 'tests/fixtures/settings.golden.json'), 'utf8'))
  assert.deepEqual(output, expected)
})

test('the saved preview paints unbound native layout without changing export diagnostics', () => {
  const mapping: CompilerMap = JSON.parse(readFileSync(join(projectRoot, 'ui-compiler.map.json'), 'utf8'))
  const page = readOpDocument(design, 'Settings')
  const frame = page.frames[0].node
  assert.equal(frame.kind, 'stack')
  frame.style.cornerRadius = 20
  frame.layout.padding = [12, 16]
  frame.layout.gap = 8
  const normal = emitDshReact(page, mapping, 'Settings')
  const preview = emitDshReact(page, mapping, 'Settings', { nativePreviewLayout: true })
  const filename = 'SettingsView.generated.module.css'
  assert.doesNotMatch(normal.files[filename], /border-radius: var\(--dsw-radius-xl\)|padding: 12px 16px;|gap: 8px;/)
  assert.match(preview.files[filename], /border-radius: var\(--dsw-radius-xl\)/)
  assert.match(preview.files[filename], /padding: 12px 16px;/)
  assert.match(preview.files[filename], /gap: 8px;/)
  assert.deepEqual(preview.report, normal.report)
})

test('a saved preview preserves numbered list examples when a search filters out earlier rows', () => {
  const mapping: CompilerMap = JSON.parse(readFileSync(join(projectRoot, 'ui-compiler.map.json'), 'utf8'))
  const page = readOpDocument(design, 'Settings')
  const root = page.frames[0].node
  assert.equal(root.kind, 'stack')
  const list = root.children.find(n => n.kind === 'stack' && n.repeat)
  assert.ok(list && list.kind === 'stack')
  const [first, second] = list.children
  first.name = 'servers[0]'
  second.name = 'servers[1]'
  const filename = 'SettingsView.generated.tsx'
  const original = emitDshReact(page, mapping, 'Settings').files[filename]
  const preview = emitDshReact(page, mapping, 'Settings', { nativePreviewLayout: true }).files[filename]
  assert.doesNotMatch(original, /previewRowIndex|data-uic-node=\{"sample"\}/)
  assert.match(preview, /item\.previewRowIndex \?\? 0\) === 1 && <>\s*\{\/\* sample · servers\[1\]/)
  assert.doesNotMatch(preview, /data-uic-unmapped/)
})

test('a repeated compile is identical and a handwritten output edit is preserved', () => {
  const out = mkdtempSync(join(tmpdir(), 'uic-manifest-'))
  try {
    const options = { projectRoot, design, frame: 'Settings', name: 'ManifestFixtureView', out, strict: false }
    compileDesign(options)
    const snapshot = Object.fromEntries(readdirSync(out).map(name => [name, readFileSync(join(out, name))]))
    compileDesign(options)
    const repeated = Object.fromEntries(readdirSync(out).map(name => [name, readFileSync(join(out, name))]))
    assert.deepEqual(repeated, snapshot)

    const generated = join(out, 'ManifestFixtureView.generated.tsx')
    const handwritten = Buffer.concat([readFileSync(generated), Buffer.from('// Hand edit\n')])
    writeFileSync(generated, handwritten)
    assert.throws(() => compileDesign(options), /Output conflict/)
    assert.deepEqual(readFileSync(generated), handwritten)
    assert.deepEqual(readFileSync(join(out, '.uic-manifest.json')), snapshot['.uic-manifest.json'])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('strict mode reports unmapped content before writing any generated file', () => {
  const out = mkdtempSync(join(tmpdir(), 'uic-strict-'))
  try {
    assert.throws(() => compileDesign({
      projectRoot, design, frame: 'Settings', name: 'StrictFixtureView', out, strict: true,
    }), /Strict compile reported/)
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
