import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { serializeDocument } from './pen-import.mjs'

import { iconNames } from './agent-editor.mjs'
export { iconNames }
const iconAliases = {close:'x', luna:'moon', refresh:'refresh-cw', trash:'trash-2'}
const kinds = ['frame','rectangle','ellipse','text','icon','theme-toggle']
const textField = (description, maxLength) => ({type:'string', description, maxLength})
const numeric = (minimum, maximum) => ({type:'number', minimum, maximum})
const choice = values => ({type:'string', enum:values})
const idField = textField('Exact node ID from the current page.', 512)
const operationFields = {
  op: choice(['add','update','remove']), id: idField, parentId: idField, kind:choice(kinds),
  beforeId:textField('Insert or move this layer immediately before this existing sibling in the same parent.',512),
  as:textField('Local parent handle for an added layer. Later adds can use parentId=@handle.',40),
  name:textField('Editable layer name.', 160), text:textField('Visible text content.', 4096),
  icon:choice([...iconNames, ...Object.keys(iconAliases)]), active:choice(['day','night']),
  x:numeric(-1000000,1000000), y:numeric(-1000000,1000000), width:numeric(1,32000), height:numeric(1,32000),
  fill:textField('Solid hex color, e.g. #4A596F.',9), stroke:textField('Solid stroke color.',9),
  strokeWidth:numeric(0,128), cornerRadius:numeric(0,16000), opacity:numeric(0,1),
  fontSize:numeric(1,512),fontFamily:textField('Font family.',160),fontWeight:numeric(100,900),
  layout:choice(['none','horizontal','vertical']), gap:numeric(0,4096),padding:numeric(0,4096),
  alignItems:choice(['start','center','end','stretch']),
  justifyContent:choice(['start','center','end','space_between','space_around','space_evenly']),
  textAlign:choice(['left','center','right','justify']),
}
const struct = (properties, required = []) => ({type:'object', additionalProperties:false, properties, required})
const readSchema = struct({query:textField('Case-insensitive substring in the name, text, icon or ID.',200),
  nodeId:idField, limit:{type:'integer',minimum:1,maximum:48},offset:{type:'integer',minimum:0,maximum:200000}})
const editSchema = struct({
  sessionId:textField('sessionId returned by read.',128), pageId:textField('pageId returned by read.',512),
  version:{type:'integer',minimum:0}, operations:{type:'array',minItems:1,maxItems:32,items:struct(operationFields,['op'])},
},['sessionId','pageId','version','operations'])

export const canvasToolSpecs = [
  {name:'uic_canvas_read',description:'Read live editable layers, current selection with exact text, IDs, parent IDs, geometry and styling (font, spacing, padding, paint and stroke). Search by query or inspect a node and its descendants. With no filter, returns the page artboards. Use offset/limit for more.',inputSchema:readSchema},
  {name:'uic_canvas_edit',description:'Apply a bounded atomic edit to the current page. Pass sessionId, pageId and version from the last read. Update existing IDs in place. To reorder a layer or insert an icon before a label in auto layout, pass beforeId (a sibling ID) on add/update. To replace a decorative icon group, update its existing ID with icon. To add a child specify parentId and kind; icon needs icon (Lucide), theme-toggle creates an editable sun/moon segmented control and active=day/night. Only remove exact IDs at the user’s request. Do not recreate a board to change one layer. Coordinates are relative to the parent.',inputSchema:editSchema},
]
const bad = (message, code = 'invalid_request', reason = code === 'canvas_changed' ? 'canvas_changed' : 'invalid_field') =>
  Object.assign(new Error(message), {code, reason, diagnostic:message})
const bounded = (x, n) => typeof x === 'string' && x.length <= n
const has = (o,k) => Object.hasOwn(o,k)
const isRecord = x => x && typeof x === 'object' && !Array.isArray(x)
const paint = color => [{type:'solid',color}]
const newId = () => 'uic_' + randomUUID().replaceAll('-','')

function validateObject(value, fields, required = []) {
  if (!isRecord(value) || Object.keys(value).some(k => !has(fields,k)) || required.some(k => !has(value,k))) {
    throw bad('Unsupported or missing canvas tool arguments')
  }
}
function validateField(key, value, rule) {
  if (rule.enum) {
    if (!rule.enum.includes(value)) throw bad('Unsupported ' + key)
  } else if (rule.type === 'string') {
    if (!bounded(value,rule.maxLength) || (key !== 'text' && !value.trim())) throw bad('Invalid ' + key)
  } else if (!Number.isFinite(value) || (rule.type === 'integer' && !Number.isSafeInteger(value))
      || value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) throw bad('Invalid ' + key)
  if (['fill','stroke'].includes(key) && !/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(value)) throw bad('Expected a hex ' + key)
}
function validateArgs(name, args) {
  const spec = canvasToolSpecs.find(s => s.name === name)
  if (!spec) throw bad('Unknown canvas tool')
  validateObject(args,spec.inputSchema.properties,spec.inputSchema.required)
  for (const [key,value] of Object.entries(args)) {
    if (key !== 'operations') { validateField(key,value,spec.inputSchema.properties[key]); continue }
    if (!Array.isArray(value) || !value.length || value.length > 32) throw bad('Use 1 to 32 canvas operations')
    for (const op of value) {
      validateObject(op,operationFields,['op'])
      for (const [field,v] of Object.entries(op)) validateField(field,v,operationFields[field])
      if (op.op === 'add' ? !op.kind || op.id : !op.id || op.parentId || op.kind || op.as) throw bad('Check operation target and kind')
      if (op.as && !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(op.as)) throw bad('Invalid local handle')
      if (op.op === 'remove' && Object.keys(op).length !== 2) throw bad('Remove accepts only op and id')
    }
  }
}

function pageOf(doc,id) {
  const page = doc.pages?.length ? doc.pages.find(p => p.id === id) ?? (/^\d+$/u.test(id) ? doc.pages[Number(id)] : undefined) : doc
  if (!Array.isArray(page?.children)) throw bad('The current canvas page changed','canvas_changed')
  return page
}
function* walk(children, parent = null) {
  const stack = []
  const push = (nodes,p) => { for (let i=nodes.length-1;i>=0;i--) stack.push({node:nodes[i],parent:p,siblings:nodes}) }
  push(children,parent)
  while (stack.length) {
    const entry = stack.pop()
    yield entry
    if (Array.isArray(entry.node.children)) push(entry.node.children,entry.node)
  }
}
function textOf(node) {
  if (node.type !== 'text') return undefined
  return Array.isArray(node.content) ? node.content.map(r => r?.text ?? r?.content ?? '').join('') : String(node.content ?? '')
}
function describe({node,parent}) {
  const text = textOf(node)
  const out = {id:node.id,name:String(node.name ?? '').slice(0,160),type:node.type,parentId:parent?.id ?? null,childCount:node.children?.length ?? 0}
  if (text !== undefined) out.text=text.slice(0,1024)
  if (node.iconFontName) out.icon=node.iconFontName
  if (Array.isArray(node.fill) && typeof node.fill[0]?.color==='string') out.fill=node.fill[0].color
  for (const k of ['x','y','width','height','cornerRadius','fontSize','fontWeight','opacity','layout','fontFamily','lineHeight','textAlign','gap','alignItems','justifyContent']) {
    if (typeof node[k]==='string'||typeof node[k]==='number') out[k]=node[k]
  }
  if (Number.isFinite(node.padding) || (Array.isArray(node.padding) && node.padding.length <= 4 && node.padding.every(Number.isFinite))) out.padding=node.padding
  if (node.stroke?.fill?.[0]?.type === 'solid') {
    out.stroke=node.stroke.fill[0].color
    if (Number.isFinite(node.stroke.thickness)) out.strokeWidth=node.stroke.thickness
  }
  return out
}
function scopeEntries(page,rootId) {
  const all = new Map()
  for (const entry of walk(page.children)) if (typeof entry.node.id === 'string') all.set(entry.node.id,entry)
  if (!rootId) return all
  const entry = all.get(rootId)
  if (!entry) throw bad('The assigned artboard changed','canvas_changed')
  const scoped = new Map([[rootId,entry]])
  for (const child of walk(entry.node.children ?? [],entry.node)) scoped.set(child.node.id,child)
  return scoped
}
function readNodes(entries,selected,args,scopeId) {
  const selection = [...new Set(selected)].slice(0,24).map(id => entries.get(id)).filter(Boolean).map(describe)
  const needle = args.query?.normalize('NFKC').toLowerCase()
  const root = args.nodeId ? entries.get(args.nodeId) : undefined
  if (args.nodeId && !root) throw bad('Layer not found on the assigned page','invalid_request','node_not_found')
  const candidates = root ? [root,...walk(root.node.children ?? [],root.node)] : entries.values()
  const nodes = []
  const offset=args.offset ?? 0, limit=args.limit ?? 24
  let total=0
  for (const entry of candidates) {
    if (!root && !needle && (scopeId ? entry.node.id !== scopeId && entry.parent?.id !== scopeId : entry.parent)) continue
    const node=entry.node
    if (needle && ![node.name,textOf(node),node.id,node.iconFontName].some(v => typeof v === 'string' && v.normalize('NFKC').toLowerCase().includes(needle))) continue
    if (total++ >= offset && nodes.length<limit) nodes.push(describe(entry))
  }
  return {selection,nodes,total, ...(offset+nodes.length<total ? {nextOffset:offset+nodes.length} : {})}
}

function iconNode(name, icon, color, size) {
  return {id:newId(), type:'icon_font', name, iconFontFamily:'lucide', iconFontName:icon,
    width:size, height:size, fill:paint(color)}
}
function themeControl(op) {
  const width=op.width ?? 76, height=op.height ?? 32
  if (height < 16 || width < 1.5*height) throw bad('Choose a theme toggle at least 16px tall and 1.5 times as wide')
  const active=op.active ?? 'day', night=active==='night'
  const size=Math.round(Math.min(height-8,width/2-5,22))
  const knob={id:newId(),type:'rectangle',name:'选中背景', x:night?width/2:2, y:2,
    width:width/2-2,height:height-4,cornerRadius:(height-4)/2,fill:paint(night?'#44506A':'#FFFFFF')}
  const children=[knob]
  for (const [index,icon] of ['sun','moon'].entries()) {
    const n=iconNode(index?'夜间':'日间',icon,night?'#F2F4FF':'#364253',size)
    n.x=width*(index ? .75 : .25)-size/2; n.y=(height-size)/2; children.push(n)
  }
  return {id:newId(),type:'frame',name:op.name ?? '日夜切换',width,height,layout:'none',cornerRadius:height/2,
    fill:paint(op.fill ?? (night?'#263046':'#EAEFF3')),children}
}
function createNode(op) {
  if (op.kind==='theme-toggle') return themeControl(op)
  if (op.kind==='icon' && !op.icon) throw bad('Choose an icon')
  if (op.kind==='icon') return iconNode(op.name ?? op.icon,iconAliases[op.icon] ?? op.icon,op.fill ?? '#344252',op.width ?? 20)
  const node={id:newId(),type:op.kind,name:op.name ?? op.kind,width:op.width ?? 100,height:op.height ?? 32}
  if (op.kind==='text') Object.assign(node,{content:op.text ?? 'Text',fontSize:14,fill:paint('#20252B')})
  else if (op.kind==='frame') Object.assign(node,{layout:'none',children:[]})
  else node.fill=paint('#CFD7E1')
  return node
}
function updateText(node,text) {
  if (!Array.isArray(node.content) || !node.content.length) { node.content=text; return }
  // Keep the existing rich-text style runs. Extend the final run when the
  // replacement is longer, and empty the unused runs when it is shorter.
  let offset=0
  const chars=Array.from(text)
  node.content=node.content.map((run,index) => {
    const key=has(run,'text')?'text':'content'
    const end=index===node.content.length-1?chars.length:Math.min(chars.length,offset+Array.from(run[key] ?? '').length)
    const value=chars.slice(offset,end).join('')
    offset=end
    return {...run,[key]:value}
  })
}
// Compact geometry-only groups commonly represent one icon (for example three
// dots). Never flatten content, component instances or reusable artwork.
function replaceIconGroup(node,options,deleted) {
  const fail = () => bad('Only a requested small decorative icon group can be replaced','invalid_request','protected_icon_group')
  if (!options.allowIconReplacement || node.id === options.scopeRootId ||
      !['frame','group'].includes(node.type) || node.reusable || node.locked ||
      ![node.width,node.height].every(v=>Number.isFinite(v) && v>0 && v<=96)) throw fail()
  const shapes = new Set(['frame','group','ellipse','rectangle','path','line','polygon','icon_font'])
  const members = []
  for (const {node:child} of walk(node.children,node)) {
    if (members.length >= 24 || !shapes.has(child.type) || child.reusable || child.locked || child.ref ||
        child.fill?.some?.(paint=>paint.type==='image')) throw fail()
    members.push(child)
  }
  if (!node.fill?.length) {
    const ink = members.find(child => child.fill?.some?.(p=>p.type==='solid'))
    if (ink) node.fill=ink.fill
    else node.fill=paint('#344252')
  }
  for (const child of members) deleted.add(child.id)
  delete node.children
}

function placeBefore(siblings,node,beforeId) {
  if (!beforeId) return
  const target=siblings.find(child=>child.id===beforeId)
  if (!target || target===node) throw bad('beforeId must be a different sibling in the same parent','invalid_request','invalid_order')
  siblings.splice(siblings.indexOf(node),1)
  siblings.splice(siblings.indexOf(target),0,node)
}

function applyFields(node,op,options,deleted) {
  if (op.icon) {
    if (node.type!=='icon_font') {
      if (node.children?.length) replaceIconGroup(node,options,deleted)
      if (!['rectangle','ellipse','text','path','frame','group'].includes(node.type)) throw bad('Choose a leaf layer to replace its icon')
      node.type='icon_font'
      for (const k of ['content','d','children','fontFamily','fontWeight','fontSize','layout']) delete node[k]
    }
    node.iconFontFamily='lucide'
    node.iconFontName=iconAliases[op.icon] ?? op.icon
  }
  if (has(op,'text')) {
    if (node.type!=='text') throw bad('Choose a text layer to update its content')
    updateText(node,op.text)
  }
  for (const k of ['fontFamily','fontSize','fontWeight','textAlign']) {
    if (has(op,k) && node.type!=='text') throw bad(k+' requires a text layer')
  }
  for (const k of ['layout','gap','padding','alignItems','justifyContent']) {
    if (has(op,k) && !['frame','group'].includes(node.type)) throw bad(k+' requires a container')
  }
  if (has(op,'active') && op.kind!=='theme-toggle') throw bad('active is a theme-toggle creation option')
  if (op.stroke || has(op,'strokeWidth')) node.stroke={...node.stroke,
    ...(op.stroke ? {fill:paint(op.stroke)} : {}),...(has(op,'strokeWidth') ? {thickness:op.strokeWidth} : {})}
  if (op.fill) node.fill=paint(op.fill)
  for (const k of ['name','x','y','width','height','cornerRadius','opacity','fontSize','fontWeight','fontFamily','textAlign','layout','gap','padding','alignItems','justifyContent']) {
    if (has(op,k)) node[k]=op[k]
  }
}
function hasOutsideRef(doc,deleted) {
  for (const page of doc.pages?.length ? doc.pages : [doc]) for (const {node} of walk(page.children)) {
    if (node.ref && deleted.has(node.ref)) return true
    if (isRecord(node.descendants) && Object.keys(node.descendants).some(path=>path.split('/').some(id=>deleted.has(id)))) return true
  }
  return false
}
function editNodes(doc,page,options,ops) {
  const changes=[],deleted=new Set(),touched=new Set(),aliases=new Map()
  for (const op of ops) {
    const entries=scopeEntries(page,options.scopeRootId)
    const entry=op.id ? entries.get(op.id) : undefined
    if (op.id && op.id===options.scopeRootId && op.beforeId) throw bad('Reorder only layers inside the assigned board')
    if (op.id && !entry) throw bad('Target layer was not found within the assigned page','invalid_request','node_not_found')
    if (op.op!=='add' && touched.has(op.id)) throw bad('Combine edits to each layer into one operation')
    if (op.op==='remove') {
      if (!options.allowDelete) throw bad('Deletion requires an explicit user request for that layer','invalid_request','unauthorized_remove')
      if (op.id===options.scopeRootId) throw bad('The assigned artboard cannot be removed','invalid_request','unauthorized_remove')
      deleted.add(op.id)
      for (const {node} of walk(entry.node.children ?? [])) deleted.add(node.id)
      entry.siblings.splice(entry.siblings.indexOf(entry.node),1)
      changes.push({op:'remove',id:op.id,name:entry.node.name})
    } else {
      let node=entry?.node, siblings=entry?.siblings
      if (op.op==='add') {
        if (op.as && aliases.has(op.as)) throw bad('Local layer handle already exists')
        if (op.parentId?.startsWith('@') && !aliases.has(op.parentId.slice(1))) throw bad('Unknown local parent handle','invalid_request','invalid_parent')
        const parentId=op.parentId?.startsWith('@') ? aliases.get(op.parentId.slice(1)) : op.parentId ?? options.scopeRootId
        const parent=parentId ? entries.get(parentId)?.node : page
        if (!parent || (parent!==page && !['frame','group'].includes(parent.type))) throw bad('Choose a frame or group on the current page as parentId','invalid_request','invalid_parent')
        node=createNode(op)
        if (op.as) aliases.set(op.as,node.id)
        if (!parent.children) parent.children=[]
        siblings=parent.children
        siblings.push(node)
      }
      if (op.op==='update' && Object.keys(op).length===2) throw bad('Provide at least one editable property')
      applyFields(node,op,options,deleted)
      placeBefore(siblings,node,op.beforeId)
      changes.push({op:op.op,id:node.id,name:node.name,expected:node,beforeId:op.beforeId})
    }
    touched.add(op.id)
  }
  if (deleted.size && hasOutsideRef(doc,deleted)) throw bad('A remaining component instance still references a removed layer','invalid_request','linked_layer')
  return changes
}

// Native saves can canonicalize defaults. Compare the fields changed by the tool
// and the identity of every inserted child, without assuming object key order.
function verifyChanges(page,changes,ops) {
  const entries=scopeEntries(page)
  const receipts=[]
  for (const [i,change] of changes.entries()) {
    const entry=entries.get(change.id)
    if (change.op==='remove') {
      if (entry) return
      receipts.push(change); continue
    }
    if (!entry || entry.node.type!==change.expected.type) return
    let nextSiblingId
    if (change.beforeId) {
      const index=entry.siblings.indexOf(entry.node), anchor=entry.siblings.findIndex(n=>n.id===change.beforeId)
      if (index<0 || anchor<=index) return
      nextSiblingId=entry.siblings[index+1].id
    }
    const fields=new Set(['name'])
    const map={text:'content',icon:'iconFontName',stroke:'stroke',strokeWidth:'stroke',kind:'type'}
    for (const key of Object.keys(ops[i])) if (!['id','op','parentId','active','as','beforeId'].includes(key)) fields.add(map[key] ?? key)
    if (ops[i].icon && entry.node.children?.length) return
    if (change.op==='add') {
      if (!isDeepStrictEqual((entry.node.children ?? []).map(n=>n.id),(change.expected.children ?? []).map(n=>n.id))) return
    }
    for (const key of fields) if (!isDeepStrictEqual(entry.node[key],change.expected[key])) return
    receipts.push({op:change.op,...describe(entry),...(nextSiblingId ? {nextSiblingId} : {})})
  }
  return receipts
}
export async function runCanvasTool(editorHost, options, name, args) {
  validateArgs(name,args)
  return editorHost.withCompilerCanvas(options,async live => {
    const [state,selection]=await Promise.all([live.read(),live.selection()])
    const visual=options.visualSelection
    if (visual && visual.sessionId!==live.id) throw bad('The canvas editor changed','canvas_changed')
    const pageId=visual?.activePageId ?? selection.activePageId
    if (options.activePageId!=null && options.activePageId!==pageId) throw bad('The canvas page changed','canvas_changed')
    const doc=JSON.parse(state.documentJson),page=pageOf(doc,pageId)
    const info={sessionId:live.id,pageId,version:state.version}
    // Issued and retained by the host for one scoped task. A sibling worker
    // may advance the page version without invalidating this board's read.
    const scopeFingerprint = () => {
      const root = page.children.find(node=>node.id===options.scopeRootId)
      if (!root) throw bad('The assigned artboard changed','canvas_changed')
      return createHash('sha256').update(JSON.stringify(root)).digest('hex')
    }
    const guard = options.scopeRootId && options.scopeRead
    if (name==='uic_canvas_read') {
      if (guard) Object.assign(guard,{...info,rootId:options.scopeRootId,hash:scopeFingerprint()})
      const selected=visual?.selectedIds ?? selection.selectedIds ?? []
      return {...info,...readNodes(scopeEntries(page,options.scopeRootId),selected,args,options.scopeRootId)}
    }
    const compatibleRead = args.version===state.version || guard && args.version===guard.version &&
      guard.sessionId===live.id && guard.pageId===pageId && guard.rootId===options.scopeRootId && guard.hash===scopeFingerprint()
    if (args.sessionId!==live.id || args.pageId!==pageId || !compatibleRead || selection.activePageId!==pageId) {
      throw bad('Canvas version or page changed; read the current page again','canvas_changed')
    }
    const changes=editNodes(doc,page,options,args.operations)
    if (!verifyChanges(page,changes,args.operations)) throw bad('Conflicting operations in this batch')
    options.signal?.throwIfAborted()
    let error
    try { await live.replaceDocument(serializeDocument(doc),state.version) } catch(cause) { error=cause }
    const next=await live.read(AbortSignal.timeout(8000))
    const receipts=next.version>state.version && verifyChanges(pageOf(JSON.parse(next.documentJson),pageId),changes,args.operations)
    if (!receipts) {
      if (error?.code==='canvas_changed' || /409|version conflict/i.test(error?.message) || next.version!==state.version) throw bad('Canvas changed; read again before retrying','canvas_changed')
      throw error ?? bad('The editor did not confirm the edit','edit_failed','write_unconfirmed')
    }
    return {...info,version:next.version,changed:receipts}
  })
}



// Ordinary DSH tools receive a trusted user event from the session. Ignore
// negated commands instead of treating a quoted layer name as permission.
export function canvasDeletionRequested(prompt) {
  if (typeof prompt!=='string') return false
  const clauses=prompt.split(/[，。；！？,;!?\n]/u)
  return clauses.some(clause => !/(?:不要|别|不能|无需|不必|不允许|避免).{0,10}(?:删|移除|去掉|清除)|\b(?:never|without|avoid|don't|do not|must not)\s+(?:delete|remove|erase|delet|remov)/iu.test(clause)
    && /删除|删掉|移除|去掉|清除|删去|去除|(?:把|将).{0,50}删(?:了)?|\b(?:remove|delete|erase)\b/iu.test(clause))
}

/** Explicit icon-replacement intent from the user's current text, never a tool argument. */
export function canvasIconReplacementRequested(prompt) {
  if (typeof prompt !== 'string') return false
  return prompt.split(/[，。；！？,;!?\n]/u).some(clause => {
    if (/(?:不要|别|不能|无需|不必|避免).{0,12}(?:换|替代|改)|\b(?:never|avoid|do not|don't)\s+(?:replace|swap|change)/iu.test(clause)) return false
    return /换成|换为|换图标|替换|更换|替代|改成|改为|更新为|\b(?:replace|swap|change)\b/iu.test(clause)
      && /图标|图案|三个点|省略号|调色板|刷新|太阳|月亮|\b(?:icon|glyph|three dots|ellipsis|palette|refresh|sun|moon)\b/iu.test(clause)
  })
}
