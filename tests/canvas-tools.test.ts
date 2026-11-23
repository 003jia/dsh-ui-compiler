import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasToolSpecs, canvasIconReplacementRequested, canvasDeletionRequested, runCanvasTool } from '../dsh-entry/canvas-tools.mjs'

function fixture() {
  const original = {pages:[{id:'p',children:[{id:'card',name:'SmartFav',type:'frame',width:260,height:90,
    children:[
      {id:'title',type:'text',name:'产品名',content:[{text:'Smart',fontWeight:700},{text:'Fav',fill:'$accent'}],x:12,y:12},
      {id:'decoration',type:'rectangle',name:'无用箭头',width:8,height:8},
      {id:'glyph',type:'rectangle',name:'按钮图标',width:20,height:20,opacity:0.85},
    ]}]},{id:'other',children:[{id:'other-layer',type:'text',name:'other',content:'private'}]}]}
  let doc=structuredClone(original), version=7, writes=0
  let conflict=false, lostAck=false
  const live={
    id:'session',selection:async()=>({activePageId:'p',selectedIds:[]}),
    read:async()=>({documentJson:JSON.stringify(doc),version}),
    replaceDocument:async (text:string,base:number)=>{
      if (conflict || base!==version) throw new Error('409 version conflict')
      doc=JSON.parse(text); version++;writes++
      if (lostAck) throw new Error('connection closed after commit')
      return version
    },
  }
  const options={sourcePath:'/project/ui.op',ownerSessionId:'project',sessionId:'session',activePageId:'p',signal:new AbortController().signal,
    visualSelection:{sessionId:'session',activePageId:'p',selectedIds:['title']}}
  const host={withCompilerCanvas:async (binding:any,op:Function)=>{assert.equal(binding.sourcePath,options.sourcePath);return op(live)}}
  const run=<N extends string>(name:N,args:any,more:any={})=>runCanvasTool(host,{...options,...more},name,args)
  const read=(args:any={},more:any={})=>run('uic_canvas_read',args,more)
  const edit=(operations:any[],more:any={},binding:any={})=>run('uic_canvas_edit',{sessionId:'session',pageId:'p',version,operations,...binding},more)
  return {original,read,edit,get doc(){return doc},get writes(){return writes},setConflict(){conflict=true},loseAck(){lostAck=true}}
}
test('open canvas tools read the visual selection, nested IDs, text, and paged queries',async()=>{
  assert.deepEqual(canvasToolSpecs.map(t=>t.name),['uic_canvas_read','uic_canvas_edit'])
  const f=fixture()
  const res=await f.read()
  assert.equal(res.version,7)
  assert.deepEqual(res.nodes.map((n:any)=>n.id),['card'])
  assert.equal(res.selection[0].text,'SmartFav')
  assert.equal(res.selection[0].parentId,'card')
  assert.deepEqual((await f.read({query:'smartfav'})).nodes.map((n:any)=>n.id),['card','title'])
  assert.deepEqual((await f.read({nodeId:'card',offset:2,limit:1})).nodes.map((n:any)=>n.id),['decoration'])
  await assert.rejects(f.read({nodeId:'other-layer'}),/not found/)
})
test('atomic targeted edits retain rich text styling, sibling identities, a real Lucide graphic and editable sun/moon children',async()=>{
  const f=fixture()
  const result=await f.edit([
    {op:'update',id:'title',text:'HelloLight',fontSize:18},
    {op:'update',id:'glyph',icon:'refresh-cw',name:'刷新'},
    {op:'remove',id:'decoration'},
    {op:'add',parentId:'card',kind:'frame',as:'tools',name:'工具'},
    {op:'add',parentId:'@tools',name:'主题模式',kind:'theme-toggle',active:'night'},
    {op:'add',parentId:'@tools',name:'配色',kind:'icon',icon:'palette'},
  ],{allowDelete:true})
  assert.equal(f.writes,1)
  assert.equal(result.changed.length,6)
  assert.equal(result.version,8)
  const card:any=f.doc.pages[0].children[0]
  const [title,icon,group]=card.children
  assert.deepEqual(title.content,[{text:'Hello',fontWeight:700},{text:'Light',fill:'$accent'}])
  assert.equal(title.x,12)
  assert.equal(title.id,'title')
  assert.equal(icon.id,'glyph')
  assert.equal(icon.opacity,.85)
  assert.equal(icon.type,'icon_font')
  assert.equal(icon.iconFontName,'refresh-cw')
  assert.equal(group.children[1].iconFontName,'palette')
  assert.deepEqual(group.children[0].children.slice(1).map((n:any)=>n.iconFontName),['sun','moon'])
  assert.equal(group.children[0].children[0].x,38)
  assert.deepEqual(f.doc.pages[1],f.original.pages[1])
})
test('an invalid later step, unapproved deletion, ref conflict, or stale view leaves the entire document intact',async()=>{
  const f=fixture()
  for (const [ops,opts,identity] of [
    [[{op:'update',id:'title',text:'changed'},{op:'remove',id:'decoration'}],{},{}],
    [[{op:'update',id:'title',text:'changed'},{op:'remove',id:'card'}],{allowDelete:true},{}],
    [[{op:'remove',id:'other-layer'}],{allowDelete:true},{}],
    [[{op:'update',id:'title',fontSize:12,evade:true}],{},{}],
    [[{op:'add',kind:'icon',icon:'http://untrusted'}],{},{}],
    [[{op:'add',parentId:'card',kind:'text',text:'abc'}],{scopeRootId:'glyph'},{}],
    [[{op:'update',id:'title',text:'changed'}],{},{version:6}],
    [[{op:'update',id:'title',text:'changed'}],{},{pageId:'other'}],
    [[{op:'update',id:'title',text:'changed'}],{},{sessionId:'other'}],
  ] as any[]) await assert.rejects(f.edit(ops,opts,identity))
  assert.equal(f.writes,0)
  assert.deepEqual(f.doc,f.original)
  ;(f.doc.pages[1].children as any[]).push({id:'instance',type:'ref',ref:'card'})
  await assert.rejects(f.edit([{op:'remove',id:'card'}],{allowDelete:true}),/references/)
  assert.equal(f.writes,0)
})
test('native version conflicts abort; an acknowledged readback resolves a lost write response',async()=>{
  const f=fixture();f.setConflict()
  await assert.rejects(f.edit([{op:'update',id:'title',text:'changed'}]),/changed/)
  const g=fixture();g.loseAck()
  const receipt=await g.edit([{op:'update',id:'title',text:'Updated'}])
  assert.equal(receipt.changed[0].text,'Updated')
  assert.equal(g.writes,1)
})
test('requires actual deletion intent for ordinary DSH agents',()=>{
  for(const prompt of ['去掉箭头','请删除两个箭头','remove the arrows','不要删除产品名，去除左箭头']) assert.ok(canvasDeletionRequested(prompt))
  for(const prompt of ['解释这个图层','不要删除产品名','do not remove these layers','never delete the button']) assert.equal(canvasDeletionRequested(prompt),false)
})

test('positions new and existing icons before a sibling and replaces requested small decorative groups in place',async()=>{
  const f=fixture()
  const card:any=f.doc.pages[0].children[0]
  const dots={id:'dots',type:'frame',name:'更多图标',width:16,height:16,x:21,children:
    [1,2,3].map(i=>({id:'dot'+i,name:'点',type:'ellipse',width:2,height:2,fill:[{type:'solid',color:'#6b7280'}]}))}
  card.children.push(dots)
  for (const prompt of ['把上面的三个点换成调色板','把右上图标换为配色图标','换图标','replace the three dots with a palette']) {
    assert.ok(canvasIconReplacementRequested(prompt))
  }
  assert.equal(canvasIconReplacementRequested('不要更换图标'),false)
  const original=structuredClone(f.doc)
  await assert.rejects(f.edit([{op:'update',id:'dots',icon:'palette'}]),{reason:'protected_icon_group'})
  await assert.rejects(f.edit([{op:'update',id:'glyph',beforeId:'other-layer'}]),{reason:'invalid_order'})
  ;(f.doc.pages[1].children as any[]).push({id:'dotInstance',type:'ref',ref:'dot2'})
  await assert.rejects(f.edit([{op:'update',id:'dots',icon:'palette'}],{allowIconReplacement:true}),{reason:'linked_layer'})
  f.doc.pages[1].children.pop()
  dots.children[0].type='text'
  await assert.rejects(f.edit([{op:'update',id:'dots',icon:'palette'}],{allowIconReplacement:true}),{reason:'protected_icon_group'})
  dots.children[0].type='ellipse'
  assert.deepEqual(f.doc,original)
  const r=await f.edit([
    {op:'update',id:'glyph',beforeId:'title',icon:'refresh-cw'},
    {op:'add',parentId:'card',kind:'icon',icon:'plus',beforeId:'dots'},
    {op:'update',id:'dots',icon:'palette'}],{allowIconReplacement:true})
  const row:any=f.doc.pages[0].children[0]
  assert.deepEqual(row.children.map((n:any)=>n.id),['glyph','title','decoration',r.changed[1].id,'dots'])
  assert.equal(r.changed[0].nextSiblingId,'title')
  assert.equal(r.changed[1].nextSiblingId,'dots')
  assert.equal(r.changed[2].childCount,0)
  assert.equal(r.changed[2].fill,'#6b7280')
  assert.equal(row.children.at(-1).x,21)
  assert.equal(row.children.at(-1).iconFontName,'palette')
})



test('concurrent workers can commit disjoint scoped reads while their own intervening edits still conflict',async()=>{
  const f=fixture()
  await f.edit([{op:'add',kind:'frame',name:'Other card'}])
  const other=f.doc.pages[0].children[1].id
  const a={scopeRootId:'card',scopeRead:{}}, b={scopeRootId:other,scopeRead:{}}
  const [readA,readB]=await Promise.all([f.read({},a),f.read({},b)])
  assert.equal(readA.version,readB.version)
  await f.edit([{op:'update',id:'card',name:'First card'}],a,{version:readA.version})
  await f.edit([{op:'update',id:other,name:'Second card'}],b,{version:readB.version})
  assert.deepEqual(f.doc.pages[0].children.map(n=>n.name),['First card','Second card'])
  const stale=await f.read({},a)
  await f.edit([{op:'update',id:'title',text:'manual edit'}])
  await assert.rejects(f.edit([{op:'update',id:'title',text:'stale worker edit'}],a,{version:stale.version}),{code:'canvas_changed'})
  await assert.rejects(f.edit([{op:'update',id:'card',beforeId:other}],a))
  assert.equal(f.writes,4)
})
