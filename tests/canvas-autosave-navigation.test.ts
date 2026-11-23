import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../dsh-entry/client.js', import.meta.url), 'utf8')
function navigationFunction(start: string, end: string, name: string, context: object) {
  const from = client.indexOf(start), to = client.indexOf(end, from)
  assert.ok(from >= 0 && to > from)
  const helper = client.slice(client.indexOf('async function flushCompilerCanvasChanges'), client.indexOf('function mountCompilerSidebarAction'))
  return runInNewContext(helper + '\n' + client.slice(from, to) + '\n' + name, context)
}

test('preview waits for the open project canvas to reach disk and cancels stale switches', async () => {
  for (const outcome of ['saved', 'failed', 'switched']) {
    const workspace = {workspaceId:'a'}
    const saved = Promise.withResolvers<boolean>()
    const changes: {previewStatus?:string}[] = []
    const requests: string[] = []
    const refresh = navigationFunction('  async function refreshPreview()', '  function showPreview()', 'refreshPreview', {
      syncWorkspace:()=>workspace, selectedWorkspace:()=>workspace, previewRequest:undefined, exportRequest:undefined,
      AbortController, disposed:new AbortController(), publish:(s:object)=>changes.push(s),
      surface:{}, getEditorWorkbenchHost:()=>({flushCompilerCanvas:(id:string)=>{ assert.equal(id,'a'); return saved.promise }}),
      projectRequest:async (operation:string,id:string)=>{
        assert.equal(id,'a'); requests.push(operation)
        return {ok:true,json:async()=>({html:'<p>Saved change</p>',inputHash:'a'.repeat(64),workspaceId:id})}
      },
    })
    const pending = refresh()
    assert.deepEqual(requests,[])
    if (outcome === 'switched') workspace.workspaceId = 'b'
    saved.resolve(outcome !== 'failed')
    await pending
    assert.deepEqual(requests,outcome === 'saved' ? ['preview'] : [])
    assert.equal(changes.at(-1)?.previewStatus, {saved:'ready',failed:'saveFailed',switched:'loading'}[outcome])
  }
})

test('closing the canvas waits for autosave and still offers explicit discard when it fails', async () => {
  for (const outcome of ['saved','keep','discard']) {
    const current = {current:{phase:'saving',dirty:true}}
    const saved = Promise.withResolvers<boolean>()
    const calls: string[] = []
    const close = navigationFunction('    async function closeCanvas()', '    const title = (state.workspace?', 'closeCanvas', {
      current, closeInFlight:{current:false}, setClosing:()=>{}, setCloseError:()=>{},
      controller:{current:{flushCompilerAutosave:()=>saved.promise, requestClose:async()=>{calls.push('closeDaemon');return true}}},
      confirmEditorClose:(dirty:boolean, confirm:()=>boolean)=>!dirty || confirm(), locale:'en',
      editorModalCopy:()=>({discard:'Discard?'}), window:{confirm:()=>{calls.push('confirm');return outcome==='discard'}},
      onClose:()=>calls.push('close'), ctx:{layout:{panelInfo:{getSnapshot:()=>({})}}},canvasId:'canvas',
    })
    const closing = close()
    assert.deepEqual(calls,[])
    assert.equal(await close(),false)
    current.current.dirty = outcome !== 'saved'
    current.current.phase = outcome === 'saved' ? 'ready' : 'error'
    saved.resolve(outcome === 'saved')
    assert.equal(await closing,outcome !== 'keep')
    assert.deepEqual(calls,outcome==='saved' ? ['closeDaemon','close'] : outcome==='discard' ? ['confirm','closeDaemon','close'] : ['confirm'])
  }
})
