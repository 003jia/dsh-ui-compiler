import assert from 'node:assert/strict'
import test from 'node:test'
const { parsePenDocument, convertPenDocument, referencedPenImages } = await import(new URL('../dsh-entry/pen-document.mjs', import.meta.url).href)

const parse = (children: unknown[], extras: Record<string, unknown> = {}) => parsePenDocument(Buffer.from(JSON.stringify({version:'2.21', children, ...extras})))
const invalid = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_pen'

test('imports editable dimensions, glyphs, vectors, references and scoped theme bindings', () => {
  const source = parse([
    {type:'frame', id:'master', reusable:true, x:-48, y:12, clip:true, padding:[0,16],
      fill:'$brand', stroke:'#bbb', strokeWidth:{bottom:1}, children:[
        {type:'icon', id:'glyph', library:'lucide', icon:'bookmark', width:20, height:20},
        {type:'text', id:'title', content:'标题', fontWeight:'500', textGrowth:'fixed-width'},
        {type:'path', id:'line', geometry:'M0 0L4 8', layoutPosition:'absolute'}]},
    {type:'ref',id:'instance',ref:'master',width:'fill_container',stroke:'#123',descendants:{
      'master/title':{content:'另一个标题', fill:'$brand'}}}
  ], {fileToken:'omit-me', themes:{mode:['light','dark']}, variables:{brand:{
    type:'color',value:[{theme:{mode:'dark'},value:'#fff'}]}}})
  assert.ok(!('fileToken' in source))
  const result = convertPenDocument(source,{namespace:'doc_'})
  assert.deepEqual([result.boardCount,result.nodeCount,result.warnings],[2,5,[]])
  const [master,instance] = result.children
  assert.deepEqual([master.x,master.y,master.layout,master.clipContent,master.width],[-48,12,'horizontal',true,'fit_content'])
  assert.deepEqual(master.stroke.thickness,{bottom:1})
  assert.deepEqual(master.fill,[{type:'solid',color:'$doc_brand'}])
  assert.deepEqual(result.variables.doc_brand.value,[{theme:{doc_mode:'dark'},value:'#fff'}])
  assert.deepEqual(result.themes,{doc_mode:['light','dark']})
  const [glyph,title,path] = master.children
  assert.deepEqual([glyph.type,glyph.iconFontName,glyph.iconFontFamily],['icon_font','bookmark','lucide'])
  assert.deepEqual([title.type,title.content,title.fontWeight,title.textGrowth],['text','标题',500,'fixed-width'])
  assert.deepEqual([path.d,path.constraints],['M0 0L4 8',{h:'left',v:'top'}])
  assert.equal(instance.ref,master.id)
  assert.equal(instance.descendants[master.id].width,'fill_container')
  assert.equal(instance.descendants[master.id].stroke.fill[0].color,'#123')
  assert.deepEqual(instance.descendants[title.id],{content:'另一个标题',fill:[{type:'solid',color:'$doc_brand'}]})
})

test('normalizes gradients, shadows and only embeds supplied raster assets', () => {
  const colors = [{position:0,color:'#fff'},{position:1,color:'#000'}]
  const img = (url: string) => ({type:'image',url,mode:'cover'})
  const source = parse([{id:'a',type:'frame',fill:[img('./images/demo.png'),img('images/missing.png'),img('https://example.org/no.png'),
    img('../private.png'),img('/tmp/private.png'),img('file:///tmp/private.png'),img('%2e%2e/private.png'),
    {type:'gradient',gradientType:'linear',rotation:12,colors}],effect:{
      type:'shadow',shadowType:'inner',offset:{x:-2,y:4},blur:6,color:'#0003'}}])
  assert.deepEqual(referencedPenImages(source),['images/demo.png','images/missing.png'])
  const data = 'data:image/png;base64,AA=='
  const result = convertPenDocument(source,{assets:new Map([['images/demo.png',data]])})
  assert.deepEqual(result.missingAssets,['images/missing.png'])
  assert.deepEqual(result.children[0].fill,[{type:'image',url:data,mode:'fill'},{
    type:'linear_gradient',angle:12,stops:[{offset:0,color:'#fff'},{offset:1,color:'#000'}]}])
  assert.deepEqual(result.children[0].effects,[{type:'shadow',inner:true,offsetX:-2,offsetY:4,blur:6,spread:0,color:'#0003'}])
})

test('rejects unreadable documents, invalid trees, duplicate IDs and dangling refs explicitly', () => {
  for (const contents of [new Uint8Array([255]),'{}','{"version":"3","children":[]}','{"version":"2.21","children":false}']) {
    assert.throws(() => parsePenDocument(contents),invalid)
  }
  assert.throws(() => parse([{type:'frame',id:'bad',children:[{type:'text',id:'bad'}]}]),invalid)
  assert.throws(() => parse([{type:'frame',id:'ok',children:1}]),invalid)
  assert.throws(() => parse([{type:'frame',id:'__proto__'}]),invalid)
  assert.throws(() => convertPenDocument(parse([{type:'ref',id:'unlinked',ref:'absent'}])),invalid)
})
