import test from 'node:test'
import assert from 'node:assert/strict'

test('CSS faces load once per family and expose aliases only after registration', async () => {
  const src = new URL('../dsh-entry/font-faces.mjs?test=load', import.meta.url).href
  const { registerProjectTypeface, projectCssFamily, noteFontRegistration, excludeProjectTypeface } = await import(src)
  const bytes = Uint8Array.of(0, 1)
  const faces = new Set()
  let finish: () => void = () => {}
  const wait = new Promise<void>(resolve => { finish = resolve })
  let attempts = 0
  const globals: any = globalThis
  const oldFontFace = Object.getOwnPropertyDescriptor(globals, 'FontFace')
  const oldDocument = Object.getOwnPropertyDescriptor(globals, 'document')
  class FakeFace {
    constructor(css: string, data: Uint8Array, descriptors: any) {
      assert.equal(css, 'DSHProjectNewsreader')
      assert.equal(data, bytes)
      assert.equal(descriptors.weight, '200 800')
    }
    async load() { attempts++; await wait; return this }
  }
  try {
    Object.defineProperty(globals, 'FontFace', { value: FakeFace, configurable: true })
    Object.defineProperty(globals, 'document', { value: { fonts: faces }, configurable: true })
    const a = registerProjectTypeface('Newsreader', ['$title'], bytes, '200 800')
    const b = registerProjectTypeface('NEWSREADER', ['$section'], bytes, '200 800')
    assert.equal(projectCssFamily('Newsreader'), undefined)
    finish()
    assert.deepEqual(await Promise.all([a, b]), [true, true])
    assert.equal(faces.size, 1)
    assert.equal(attempts, 1)
    assert.equal(projectCssFamily('"NEWSREADER", serif'), 'DSHProjectNewsreader')
    assert.equal(projectCssFamily(' "$section" , serif'), 'DSHProjectNewsreader')
    assert.equal(projectCssFamily('serif, Newsreader'), undefined)
    noteFontRegistration('$section')
    assert.equal(projectCssFamily('$section'), 'DSHProjectNewsreader')
    noteFontRegistration('$section')
    assert.equal(projectCssFamily('$section'), undefined)
    excludeProjectTypeface('newsreader')
    assert.equal(projectCssFamily('$title'), undefined)
    excludeProjectTypeface('newsreader', false)
    assert.equal(projectCssFamily('$title'), 'DSHProjectNewsreader')
    noteFontRegistration('$title', 'remove')
    assert.equal(projectCssFamily('$title'), undefined)
    assert.equal(await registerProjectTypeface('IBM Plex Mono', [], bytes, '400'), false)
    Object.defineProperty(globals, 'FontFace', { value: class { async load() { throw Error('font failure') } }, configurable: true })
    assert.equal(await registerProjectTypeface('Noto Sans SC', ['$body'], bytes, '100 900'), false)
    assert.equal(projectCssFamily('$body'), undefined)
  } finally {
    if (oldFontFace) Object.defineProperty(globals, 'FontFace', oldFontFace)
    else delete globals.FontFace
    if (oldDocument) Object.defineProperty(globals, 'document', oldDocument)
    else delete globals.document
  }
})
