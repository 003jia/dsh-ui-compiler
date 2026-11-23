import assert from 'node:assert/strict'
import test from 'node:test'

const { collectCanvasFontFamilies } = await import(new URL('../dsh-entry/font-families.mjs', import.meta.url).href)

test('font plan resolves exact families and referenced aliases without changing Pencil data', () => {
  const alias = '$pen_' + 'a'.repeat(64) + '_sf-font'
  const doc = { variables: {
    [alias.slice(1)]: { type: 'string', value: '$base' },
    base: { type: 'string', value: 'Noto Sans SC' },
    unused: { type: 'string', value: 'Unused' },
    cyclic: { type: 'string', value: '$cyclic' },
    bad: { type: 'color', value: 'Not a font' },
  }, children: [{ type: 'frame', children: [
    { type: 'text', name: '产品名', fontFamily: alias, content: 'SmartFav' },
    { type: 'text', fontFamily: 'Newsreader', content: [{ text: 'A', fontFamily: 'Inter' }, { text: 'B', fontFamily: '$base' }] },
    { type: 'text', fontFamily: '$missing' }, { type: 'text', fontFamily: '$cyclic' }, { type: 'text', fontFamily: '$bad' },
    { type: 'icon_font', iconFontFamily: 'Lucide' },
    { type: 'ref', descendants: { child: { fontFamily: 'IBM Plex Mono', content: [{ text: 'C', fontFamily: alias }] } } },
  ] }] }
  const before = JSON.stringify(doc)
  const plan = collectCanvasFontFamilies(doc)
  assert.deepEqual(plan.map((item: {family: string}) => item.family).sort(), ['IBM Plex Mono', 'Inter', 'Newsreader', 'Noto Sans SC'])
  assert.deepEqual(plan.find((item: {family: string}) => item.family === 'Noto Sans SC').aliases.sort(), ['$base', alias].sort())
  assert.deepEqual(collectCanvasFontFamilies(doc, new Set(['Newsreader'])), [{family:'Newsreader', aliases:[]}])
  assert.equal(JSON.stringify(doc), before)
})

test('font plan resolves inherited themes, falls back in native order, and never binds an ambiguous global alias', () => {
  const doc = { variables: {
    face: { type: 'string', value: [{ theme: { mode:'dark' }, value:'Dark Face' }, { value:'Default Face' }] },
    themed: { type: 'string', value: [{theme:{mode:'dark'},value:'First Face'}] },
    other: { type: 'string', value:'$face' },
  }, pages: [{ children: [
    { type:'text', fontFamily:'$face' },
    { type:'frame', theme:{mode:'dark'}, children:[{type:'text', fontFamily:'$other'}, {type:'text', fontFamily:'$face'}] },
    { type:'ref', descendants: { target:{descendants:{label:{ fontFamily:'$themed' }}} } },
  ] }] }
  const plan = collectCanvasFontFamilies(doc)
  assert.deepEqual(new Map(plan.map((x: {family: string;aliases: string[]}) => [x.family,x.aliases])),
    new Map([['Default Face', []], ['Dark Face', ['$other']], ['First Face', ['$themed']]]))
  const dark = collectCanvasFontFamilies(doc, new Set(['Dark Face']), {mode:'dark'})
  assert.deepEqual(dark[0].aliases.sort(), ['$face','$other'])
})
