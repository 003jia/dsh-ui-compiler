import assert from 'node:assert/strict'
import test from 'node:test'

const { compilerRecoveryMatchesSource } = await import(new URL('../dsh-entry/agent-editor.mjs', import.meta.url).href)
const meta = {activePageIndex:0, preserveAuthoredGeometry:false}
const document = {
  version: '1.0.0',
  children: [{id:'a',type:'text',content:'Original',fontFamily:'Newsreader'}, {id:'b',type:'frame'}],
  variables: {foreground:'#333333'},
  pages: [{id:'page',name:'Page 1'}],
}
const compare = (a: unknown, b: unknown) => compilerRecoveryMatchesSource(JSON.stringify(a),JSON.stringify(b))

test('the default editor metadata omitted by the daemon is the only ignored difference', () => {
  const saved = {...document, editorMeta: meta}
  assert.equal(compare(saved,document),true)
  assert.equal(compare(document,saved),true)
  assert.equal(compare(saved,{pages:document.pages,variables:document.variables,children:document.children,version:document.version}),true)
  for (const changed of [
    {...document, children:document.children.map(n=>({...n,content:'Changed'}))},
    {...document, children:document.children.map(n=>({...n,fontFamily:'Other'}))},
    {...document, children:document.children.toReversed()},
    {...document, variables:{foreground:'#444444'}},
    {...document, pages:[{id:'page',name:'Renamed'}]},
    {...document, extraData:42},
  ]) assert.equal(compare(saved,changed),false)
  for (const different of [
    {...meta,activePageIndex:1}, {...meta,preserveAuthoredGeometry:true},
    {...meta,other:false}, {}, null, [], {activePageIndex:0},
  ]) assert.equal(compare({...document,editorMeta:different},document),false)
})
