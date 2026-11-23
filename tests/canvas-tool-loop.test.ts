import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCanvasDesign } from '../dsh-entry/agent-host.mjs'
// @ts-ignore The canvas host ships this browser-independent ES module.
import { canvasToolSpecs, runCanvasTool } from '../dsh-entry/canvas-tools.mjs'

// Feed complete SDK blocks; production uses DSH BlockAssembler to merge deltas
// and attach the provider's replay metadata (including thinking signatures).
class TestAssembler {
  blocks: any[] = []
  replayState: any
  push(chunk: any) {
    if (chunk.type === 'block-end') this.blocks[chunk.index] = chunk.block
    if (chunk.type === 'finish') this.replayState = chunk.replayState
  }
  message(source: unknown) { return {role:'assistant', source, content:this.blocks} }
}
const protocol = { BlockAssembler:TestAssembler, createUserMessage:(v: any) => ({...v,role:'user'}),
  createToolResultMessage:(v:any) => ({role:'tool', toolCallId:v.callId, ...v}) }
const text = (value: any) => ({type:'text', text:JSON.stringify(value)})
const tool = (id:string, name:string, args: any) => ({type:'tool-call', id, name, arguments:JSON.stringify(args)})
async function* stream(...blocks:any[]) {
  for (const [index, block] of blocks.entries()) yield {type:'block-end', index, block}
  yield {type:'finish', reason:{kind:blocks.some(b => b.type==='tool-call')?'tool-calls':'stop'},replayState:{response:{reference:1}}}
}
function fixture(choose: (request: any, n:number) => AsyncGenerator<any>, readOnly=false) {
  let doc:any = {version:'2.9',children:[{type:'frame',id:'card',name:'设置',width:200,height:180,children:[
    {type:'text',id:'label',name:'旧按钮',content:'旧按钮',width:60,height:20}]}]}
  let version=7, calls=0, writes=0
  const receipts:any[]=[]
  const live = {id:'native', read:async()=>({version,documentJson:JSON.stringify(doc)}),
    selection:async()=>({activePageId:'page',selectedIds:['label']}),
    replaceDocument:async(raw:string,base:number)=>{assert.equal(base,version);doc=JSON.parse(raw);version++;writes++}}
  const signal = new AbortController().signal
  const input = {llm:{stream:(request:any)=>choose(request,calls++)}, modelSelection:{provider:'test',model:'design'},context:{},
    prompt:'更新按钮文字，添加日夜切换', signal,
    canvasTools:{protocol,receipts,specs:canvasToolSpecs.filter((s:any)=>!readOnly||s.name==='uic_canvas_read'),
      execute:(name:string,args:any)=>runCanvasTool({withCompilerCanvas:(_o:any,op:Function)=>op(live)},
        {sessionId:'native',activePageId:'page',signal},name,args)}}
  return {run:()=>generateCanvasDesign(input), state:()=>({doc,writes,calls,receipts})}
}

test('real read and atomic edit results feed back into the next provider request',async()=>{
  const f=fixture((r,n)=>{
    assert.deepEqual(r.tools.map((s:any)=>s.name),['uic_canvas_read','uic_canvas_edit'])
    if(n===0)return stream(tool('r','uic_canvas_read',{}))
    const last=r.messages.at(-1), value=JSON.parse(last.content[0].text)
    assert.equal(last.role,'tool')
    assert.deepEqual(r.messages.at(-2).source.replayState.response,{reference:1})
    if(n===1){
      assert.equal(value.selection[0].text,'旧按钮')
      const {sessionId,pageId,version}=value
      return stream(tool('e','uic_canvas_edit',{sessionId,pageId,version,operations:[
        {op:'update',id:value.selection[0].id,text:'检查更新'},
        {op:'add',kind:'theme-toggle',parentId:'card',name:'外观切换',active:'day'},
      ]}))
    }
    assert.equal(value.changed.length,2)
    return stream(text({reply:'按钮已更新，并新增外观切换。'}))
  })
  const result=await f.run(),s=f.state()
  assert.equal(s.writes,1)
  assert.deepEqual(s.doc.children[0].children.map((n:any)=>n.id==='label'?n.content:n.name),['检查更新','外观切换'])
  assert.deepEqual(result.toolCalls?.map(row=>[row.name,row.status]),[['uic_canvas_read','success'],['uic_canvas_edit','success']])
})

test('a postcommit provider failure still returns the confirmed edit and never replays mutation',async()=>{
  const f=fixture((_r,n)=>{
    if(n===0)return stream(tool('read','uic_canvas_read',{}))
    if(n===1)return stream(tool('write','uic_canvas_edit',{sessionId:'native',pageId:'page',version:7,operations:[{op:'update',id:'label',text:'完成'}]}))
    throw new Error('provider unavailable')
  })
  const result=await f.run()
  assert.equal(f.state().writes,1)
  assert.match(result.reply,/已更新画布/)
  assert.equal(result.toolCalls?.at(-1)?.status,'success')
})

test('JSON-only provider uses the same tools and cannot turn a rejected edit into claimed success',async()=>{
  const f=fixture((r,n)=>{
    if(n===0)throw Object.assign(new Error('tools not supported'),{code:'UNSUPPORTED_OPTION'})
    assert.equal(r.tools,undefined)
    if(n===1)return stream(text({tool:{name:'uic_canvas_edit',arguments:{sessionId:'foreign',pageId:'x',version:1,operations:[]}}}))
    assert.equal(JSON.parse(r.messages.at(-1).content[0].text).canvasToolResult.isError,true)
    return stream(text({reply:'all done'}))
  })
  await assert.rejects(f.run(),(e:any)=>e.code==='edit_failed')
  assert.equal(f.state().writes,0)
  assert.equal(f.state().receipts[0].status,'error')
})

test('parallel workers receive only the read schema and cannot edit the shared canvas',async()=>{
  const f=fixture((r,n)=>{
    assert.deepEqual(r.tools.map((s:any)=>s.name),['uic_canvas_read'])
    if(n===0)return stream(tool('forged','uic_canvas_edit',{}))
    assert.equal(r.messages.at(-1).isError,true)
    return stream(text({reply:'不能更改其他工作区。'}))
  },true)
  await assert.rejects(f.run(),(e:any)=>e.code==='edit_failed')
  assert.deepEqual(f.state().receipts,[])
  assert.equal(f.state().writes,0)
})

function writeBatch(id: string, version: number, operations: any[]) {
  return stream(tool(id,'uic_canvas_edit',{sessionId:'native',pageId:'page',version,operations}))
}

test('a second distinct edit after a fresh read uses the committed version', async()=>{
  const f=fixture((r,n)=>{
    if(n===0 || n===2)return stream(tool('r'+n,'uic_canvas_read',{}))
    const receipt=JSON.parse(r.messages.at(-1).content[0].text)
    if(n===1)return writeBatch('first',receipt.version,[{op:'update',id:'label',text:'检查更新'}])
    if(n===3){
      assert.equal(receipt.version,8)
      assert.equal(receipt.selection[0].text,'检查更新')
      return writeBatch('second',receipt.version,[{op:'add',parentId:'card',kind:'theme-toggle',name:'外观切换'}])
    }
    return stream(text({reply:'已改文字并添加外观切换。'}))
  })
  const result=await f.run()
  assert.equal(f.state().writes,2)
  assert.equal(f.state().doc.children[0].children.length,2)
  assert.equal(result.toolCalls?.filter(r=>r.name==='uic_canvas_edit' && r.status==='success').length,2)
})
test('a consumed version, a duplicate operation and an invalid later step are all reported without extra writes',async()=>{
  const add={op:'add',kind:'theme-toggle',parentId:'card',name:'外观切换'}
  const f=fixture((r,n)=>{
    if(n===0 || n===3)return stream(tool('r'+n,'uic_canvas_read',{}))
    if(n===1)return writeBatch('write',7,[add])
    if(n===2)return writeBatch('stale',7,[{op:'update',id:'label',text:'完成'}])
    if(n===4)return writeBatch('again',8,[{name:add.name,parentId:'card',kind:'theme-toggle',op:'add'}])
    if(n===5)return writeBatch('bad',8,[{op:'update',id:'card',text:'不要写入的用户原文'}])
    assert.match(r.messages.at(-1).content[0].text,/修改文字需要选择文本子图层/)
    return stream(text({reply:'已全部完成'}))
  })
  const result=await f.run(),s=f.state()
  assert.equal(s.writes,1)
  assert.equal(s.doc.children[0].children.length,2)
  assert.match(result.reply,/已完成.*外观切换/)
  assert.match(result.reply,/未完成.*重新读取/)
  assert.match(result.reply,/未完成.*重复项/)
  assert.match(result.reply,/未完成.*文本子图层/)
  assert.doesNotMatch(result.reply,/已全部完成|不要写入的用户原文/)
  assert.doesNotMatch(JSON.stringify(result.toolCalls),/不要写入的用户原文/)
})
test('duplicate provider tool ID following a confirmed write cannot issue another write', async()=>{
  const f=fixture((_r,n)=>{
    if(n===0 || n===2)return stream(tool('r'+n,'uic_canvas_read',{}))
    if(n===1)return writeBatch('same-id',7,[{op:'update',id:'label',text:'检查更新'}])
    return writeBatch('same-id',8,[{op:'add',parentId:'card',kind:'theme-toggle'}])
  })
  const result=await f.run()
  assert.equal(f.state().writes,1)
  assert.match(result.reply,/重复的工具调用编号已拒绝/)
})
