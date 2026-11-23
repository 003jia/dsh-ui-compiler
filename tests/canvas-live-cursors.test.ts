import assert from 'node:assert/strict'
import test from 'node:test'

const { createCompilerSelectionBridge } = await import(new URL('../dsh-entry/selection-bridge.mjs',import.meta.url).href)
const { applyParallelFrames, prepareAgentWorkAreas, resolveAgentWorkTarget } =
  await import(new URL('../dsh-entry/agent-editor.mjs',import.meta.url).href)

test('native cursor relay keeps agent ownership and returns to a revisited layer without replaying duplicate polls', () => {
  const listeners = new Map()
  let time = 3200
  const parent = {}, origin = 'dsh-app://app'
  const frame = {parent,location:new URL('http://127.0.0.1:20000/?embed=vscode'),
    performance:{now:()=>time},addEventListener:(name:string,fn:Function)=>listeners.set(name,fn)}
  const bridge = createCompilerSelectionBridge(frame)
  const send = (data:any, from = origin) => listeners.get('message')({source:parent,origin:from,data})
  send('{"type":"op-bridge/init","version":1}')
  const select = {}
  bridge.opened(select,'POST','/api/mcp/selection')
  bridge.sent(select,JSON.stringify({activePageId:'home',selectedIds:[]}))
  const request = {}, other = {}
  bridge.opened(request,'GET','/api/mcp/indicators')
  bridge.opened(other,'GET','/api/mcp/document')
  const original = JSON.stringify({epoch:4,active:false})
  const state = (targetId:string,seq:number) => ({type:'uic/agent-work',requestId:'run',pageId:'home',
    slots:[{index:1,title:'Layout',status:'running',targetId,points:[{seq,targetId}]},
      {index:2,title:'Settings',status:'running',targetId:'icon',points:[{seq:1,targetId:'icon',anchorId:'button'}]}]})
  const poll = () => JSON.parse(bridge.indicatorBody(request,original))
  send(state('a',1),'https://example.com')
  assert.equal(bridge.indicatorBody(request,original),original)
  send(state('a',1))
  const first=poll()
  assert.equal(first.active,true)
  assert.deepEqual(first.nodes.map((node:any)=>[node.id,node.name]),[['a','Agent 1 · Layout'],['button','Agent 2 · Settings']])
  assert.equal(bridge.indicatorBody(other,'unrelated'),'unrelated')
  const native = '{"active":true,"epoch":2}'
  assert.equal(bridge.indicatorBody(request,native),native)
  time+=850;send(state('b',2));const middle=poll()
  time+=850;send(state('a',3));const again=poll()
  assert.ok(again.epoch>middle.epoch)
  assert.ok(again.reveals.find((r:any)=>r.id==='a').ms > again.reveals.find((r:any)=>r.id==='b').ms)
  assert.equal(again.reveals.find((r:any)=>r.id==='button').ms,first.reveals.find((r:any)=>r.id==='button').ms)
  time+=600;send(state('a',3));assert.deepEqual(poll(),again)
  bridge.opened(select,'POST','/api/mcp/selection')
  bridge.sent(select,JSON.stringify({activePageId:'elsewhere',selectedIds:[]}))
  assert.equal(poll().active,false)
  send({type:'uic/agent-work',requestId:'run',pageId:'home',slots:[]})
  assert.equal(poll().active,false)
})

test('independent worker commits preserve existing boards and lost receipts, without changing user selection',async()=>{
  let version=1
  const initial={type:'frame',id:'home',name:'Home',x:0,y:0,width:320,height:180}
  let doc:any={pages:[{id:'p',children:[initial]}]}
  const selection={activePageId:'p',selectedIds:['home']}
  const calls:string[]=[]
  const live = {id:'s',selection:async()=>selection,read:async()=>({documentJson:JSON.stringify(doc),version}),
    call:async (tool:string)=>{calls.push(tool);return {value:{layout:doc.pages[0].children}}},
    replaceDocument:async (json:string,v:number)=>{assert.equal(v,version);doc=JSON.parse(json);version++;throw Error('lost ack')}}
  const host={withCompilerCanvas:(_:any,run:Function)=>run(live)}
  const snapshot={sessionId:'s',activePageId:'p',context:{}}
  const args={snapshot,batchKey:'group',incremental:true,signal:new AbortController().signal}
  const areas=await prepareAgentWorkAreas(host,2,args)
  assert.equal(areas.length,2)
  const one=(index:number)=>({index,round:0,frame:{type:'frame',name:'Task '+index,width:450,height:180,children:[
    {type:'rectangle',name:'Action',width:140,height:46}]}})
  const write=(i:number)=>applyParallelFrames(host,[one(i)],{...args,workAreas:areas})
  const [two]=await write(2);assert.equal(doc.pages[0].children.length,2)
  const [first]=await write(1);assert.equal(doc.pages[0].children.length,3)
  const [,b,a]=doc.pages[0].children
  assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y)
  assert.equal(first.targetIds[0],a.id);assert.equal(first.targetIds[1],a.children[0].id)
  assert.deepEqual(await write(2),[two])
  assert.equal(version,3);assert.equal(calls.includes('set_selection'),false)
  assert.deepEqual(doc.pages[0].children[0],initial)
  Object.assign(doc.pages[0].children[0],{children:[{id:'tiny',x:20,y:30,width:14,height:14}]})
  assert.deepEqual(await resolveAgentWorkTarget(host,'tiny',args),{x:27,y:37,anchorId:'home'})
})


test('two planning pens park visibly before any renderer bounds or native selection sample; a bound target hands off to native paint',()=>{
  const listeners = new Map(), parent = {}, origin='dsh-app://app'
  const make = ():any => ({dataset:{},style:{},children:[],setAttribute(k:string,v:string){this[k]=v},
    append(...nodes:any[]){this.children.push(...nodes)},appendChild(node:any){this.append(node)},
    replaceChildren(){this.children=[]},remove(){this.removed=true}})
  const body=make()
  const doc={body,createElement:make,createElementNS:make,getElementById:()=>({getBoundingClientRect:()=>({left:4,top:8,width:700,height:500})})}
  const frame={parent,document:doc,location:new URL('http://localhost/?embed=vscode&locale=zh-CN'),
    addEventListener:(n:string,l:Function)=>listeners.set(n,l)}
  const bridge=createCompilerSelectionBridge(frame)
  const send=(data:any)=>listeners.get('message')({source:parent,origin,data})
  send('{"type":"op-bridge/init","version":1}')
  const progress={type:'uic/agent-work',requestId:'a',pageId:'0',slots:[{index:1,status:'queued'},{index:2,status:'queued'}]}
  send(progress)
  const dock=body.children[0]
  assert.equal(dock['aria-label'],'正在规划的画布 Agent')
  assert.equal(dock.style.left,'4px')
  assert.deepEqual(dock.children.map((c:any)=>c.children[1].textContent),['Agent 1 · 规划中','Agent 2 · 规划中'])
  const poll={};bridge.opened(poll,'GET','/api/mcp/indicators')
  assert.equal(JSON.parse(bridge.indicatorBody(poll,'{"active":false}')).active,false)
  assert.equal(dock.removed,undefined)
  const sel={};bridge.opened(sel,'POST','/api/mcp/selection');bridge.sent(sel,'{"activePageId":"0","selectedIds":[]}')
  send({...progress,slots:progress.slots.map(s=>({...s,status:'running',targetId:'layer-'+s.index}))})
  assert.equal(dock.removed,true)
  assert.equal(JSON.parse(bridge.indicatorBody(poll,'{"active":false}')).nodes.length,2)
})
