import assert from 'node:assert/strict'
import test from 'node:test'
const { createProjectTextRenderer, patchCompilerFontRenderer } =
  await import(new URL('../dsh-entry/font-weights.mjs', import.meta.url).href)

test('named project variable faces are used only after both browser and editor registration', () => {
  const entries = new Map([
    ['primary stack',{source:'imported',familyKey:'$ed-font'}],
    ['manually imported',{source:'imported',familyKey:'other'}],
    ['bundled',{source:'bundled',familyKey:'$ed-font'}],
  ])
  let project = true
  const lookUp = (stack: string) => entries.get(stack)
  const active = (name: string) => name === '$ed-font' && project ? 'ProjectNoto' : undefined
  const make = (ctx: any) => createProjectTextRenderer(lookUp, active, null, null, null, ctx)
  const paths = make({})
  assert.equal(paths.family('primary stack'), 'ProjectNoto')
  assert.equal(paths.family('manually imported'), undefined)
  assert.equal(paths.family('bundled'), undefined)
  assert.equal(paths.family('deleted'), undefined)
  assert.equal(make(null).family('primary stack'), undefined)
  project = false
  assert.equal(paths.family('primary stack'), undefined)
})

test('normal and bold use identical per-run sizing in drawing and measuring, retaining emoji colour', () => {
  const parts = [{text:'收藏',emoji:false},{text:'📌',emoji:true}]
  const measured: any[] = [], drawn: any[] = []
  const width = (text: string, weight: number) => [...text].length * weight / 100
  const paths = createProjectTextRenderer(null, null, () => parts,
    (text: string,x: number,y: number,sz: number,weight: number,italic: boolean,r: number,g: number,b: number,a: number,emoji: boolean,css: string) => {
      drawn.push([text,x,y,sz,weight,italic,emoji,css])
      return width(text,weight)
    },
    (text:string, sz:number, weight:number, italic:boolean, css:string) => {
      measured.push([text,sz,weight,italic,css])
      return width(text,weight)
    }, {})
  for (const weight of [400,700]) {
    drawn.length=0; measured.length=0
    paths.draw('收藏📌','ProjectNoto',10,40,22,weight,true,1,0,0,1)
    assert.equal(paths.measure('收藏📌','ProjectNoto',22,weight,true),width('收藏📌',weight))
    assert.deepEqual(drawn,[
      ['收藏',10,40,22,weight,true,false,'ProjectNoto'],
      ['📌',10+width('收藏',weight),40,22,weight,true,true,'ProjectNoto'],
    ])
    assert.deepEqual(measured,parts.map(part=>[part.text,22,weight,true,'ProjectNoto']))
  }
  assert.throws(() => patchCompilerFontRenderer('unknown renderer'), /version/)
})
