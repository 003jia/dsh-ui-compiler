import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'
import { canvasToolSpecs, runCanvasTool, canvasDeletionRequested, canvasIconReplacementRequested } from './canvas-tools.mjs'
import { assetDataUrl, findAsset } from './asset-store.mjs'
import { insertCanvasNode } from './agent-editor.mjs'

// Model-facing drawing tools over the project canvas that the UI compiler
// sidebar currently has open. They never choose a project or path; the Host
// resolves the active binding recorded by the canvas route.

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function canvasOptions(active, exec) {
  const binding = active.binding
  if (binding === null) throw new Error('The UI compiler canvas is not open. Open it from the project sidebar first.')
  if (exec.agent && (!exec.agent.session?.header?.cwd || resolve(exec.agent.session.header.cwd)!==resolve(binding.workspaceRoot))) {
    throw new Error('Open the project canvas belonging to this DSH conversation.')
  }
  return { sourcePath: binding.sourcePath, ownerSessionId: binding.ownerSessionId, signal: exec.signal }
}

function documentPage(snapshot, pageId) {
  const document = JSON.parse(snapshot.documentJson)
  const page = document.pages?.length
    ? document.pages.find(candidate => candidate.id === pageId) ?? (/^\d+$/u.test(pageId) ? document.pages[Number(pageId)] : undefined)
    : document
  if (!Array.isArray(page?.children)) throw new Error('The canvas page is unavailable')
  return page
}

function summarize(node) {
  return {
    id: node.id, name: String(node.name ?? '').slice(0, 180), type: node.type,
    x: node.x, y: node.y, width: node.width, height: node.height,
  }
}

function findById(root, id) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (node?.id === id) return node
    if (Array.isArray(node?.children)) pending.push(...node.children)
  }
  return undefined
}

function findByName(root, name) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (typeof node?.name === 'string' && node.name === name) return node
    if (Array.isArray(node?.children)) pending.push(...node.children)
  }
  return undefined
}

// DSH's authoring DSL marks required fields on individual properties. The
// executor enforces the full input schema, including size and numeric limits.
function dshProperties(schema) {
  return Object.fromEntries(Object.entries(schema.properties).map(([key,field]) => {
    const value = dshField(field)
    if (schema.required?.includes(key)) value.required = true
    return [key,value]
  }))
}
function dshField(field) {
  const out = {type:field.type}
  if (field.description) out.description=field.description
  if (field.enum) out.enum=field.enum
  if (field.type==='array') out.items=dshField(field.items)
  if (field.type==='object') { out.properties=dshProperties(field); out.additionalProperties=false }
  return out
}

/** Create tools bound to the currently open project canvas. */
export function createCompilerDrawTools(editorHost, active) {
  const select = defineTool({
    name: 'uic_canvas_select',
    description: 'Point at the live UI compiler canvas. Select a node by id or exact layer name, or list the active page frames and selection. '
      + 'The canvas must already be open in the project sidebar. Use this to see what is on the canvas before drawing or moving nodes.',
    parameters: {
      nodeId: { type: 'string', description: 'Node id to select.' },
      name: { type: 'string', description: 'Exact layer name to select when nodeId is omitted.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true },
          pageId: { type: 'string', required: true },
          frames: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          selected: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      return editorHost.withCompilerCanvas(canvasOptions(active, exec), async live => {
        const [selection, state] = await Promise.all([live.selection(), live.read()])
        const page = documentPage(state, selection.activePageId)
        const target = args.nodeId !== undefined ? findById(page, args.nodeId) : args.name !== undefined ? findByName(page, args.name) : undefined
        if ((args.nodeId !== undefined || args.name !== undefined) && target === undefined) throw new Error('No matching canvas node was found')
        if (target !== undefined) await live.call('set_selection', { node_id: target.id }, AbortSignal.timeout(7000))
        const selected = target !== undefined
          ? [{ ...summarize(target) }]
          : selection.nodes.slice(0, 12).map(summarize)
        return {
          sessionId: live.id,
          pageId: selection.activePageId,
          frames: page.children.slice(0, 32).map(summarize),
          selected,
        }
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Select on UI canvas', kind: 'read' }),
  })

  const draw = defineTool({
    name: 'uic_canvas_draw',
    description: 'Draw one shape or text layer on the live UI compiler canvas at the given box. '
      + 'Use rectangle, ellipse, text, or frame; width and height are pixel numbers. The canvas must already be open, and the new node is selected but unsaved until the sidebar Save action.',
    parameters: {
      type: { type: 'string', required: true, enum: ['rectangle', 'ellipse', 'text', 'frame'], description: 'Layer type to draw.' },
      name: { type: 'string', description: 'Layer name. Defaults to the type name.' },
      x: { type: 'number', description: 'Left edge in canvas coordinates. Omit to place beside the selection.' },
      y: { type: 'number', description: 'Top edge in canvas coordinates. Omit to place beside the selection.' },
      width: { type: 'number', required: true, description: 'Width in pixels.' },
      height: { type: 'number', required: true, description: 'Height in pixels.' },
      fill: { type: 'string', description: 'Solid fill such as #203040.' },
      cornerRadius: { type: 'number', description: 'Corner radius in pixels.' },
      text: { type: 'string', description: 'Visible copy for a text layer.' },
      fontSize: { type: 'number', description: 'Text size in pixels.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true },
          type: { type: 'string', required: true }, x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (!Number.isFinite(args.width) || args.width <= 0 || !Number.isFinite(args.height) || args.height <= 0) {
        throw new Error('width and height must be positive pixel numbers')
      }
      const node = {
        type: args.type,
        name: args.name?.trim() || args.type,
        width: args.width, height: args.height,
        ...(Number.isFinite(args.x) ? { x: args.x } : {}),
        ...(Number.isFinite(args.y) ? { y: args.y } : {}),
        ...(typeof args.fill === 'string' && args.fill.trim() !== '' ? { fill: [{ type: 'solid', color: args.fill.trim() }] } : {}),
        ...(Number.isFinite(args.cornerRadius) ? { cornerRadius: args.cornerRadius } : {}),
        ...(args.type === 'text' ? { content: args.text ?? 'Text', fontSize: Number.isFinite(args.fontSize) ? args.fontSize : 14 } : {}),
      }
      return insertCanvasNode(editorHost, node, canvasOptions(active, exec))
    },
    presentCall: args => ({ card: 'generic', title: `Draw ${args.type} on UI canvas`, kind: 'execute' }),
  })

  const move = defineTool({
    name: 'uic_canvas_move',
    description: 'Move or resize one existing node by id on the live UI compiler canvas. '
      + 'Only x, y, width and height change; other node fields stay untouched. The canvas must already be open.',
    parameters: {
      nodeId: { type: 'string', required: true, description: 'Target node id from uic_canvas_select.' },
      x: { type: 'number', description: 'New left edge.' },
      y: { type: 'number', description: 'New top edge.' },
      width: { type: 'number', description: 'New width.' },
      height: { type: 'number', description: 'New height.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true },
          type: { type: 'string', required: true }, x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const data = Object.fromEntries(['x', 'y', 'width', 'height']
        .filter(key => Number.isFinite(args[key])).map(key => [key, args[key]]))
      if (Object.keys(data).length === 0) throw new Error('Provide at least one of x, y, width or height')
      return editorHost.withCompilerCanvas(canvasOptions(active, exec), async live => {
        const selection = await live.selection()
        await live.call('update_node', { nodeId: args.nodeId, data }, AbortSignal.timeout(15000))
        const page = documentPage(await live.read(AbortSignal.timeout(7000)), selection.activePageId)
        const node = findById(page, args.nodeId)
        if (node === undefined) throw new Error('The updated node is no longer on the canvas')
        await live.call('set_selection', { node_id: node.id }, AbortSignal.timeout(7000)).catch(() => {})
        return summarize(node)
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Move UI canvas node', kind: 'execute' }),
  })

  const image = defineTool({
    name: 'uic_canvas_image',
    description: 'Place an image that the user uploaded to this project onto the live UI compiler canvas. '
      + 'Pass the assetId returned by the project upload; width and height default to 480x360. The canvas must already be open.',
    parameters: {
      assetId: { type: 'string', required: true, description: 'Uploaded asset id (64 lowercase hex characters).' },
      x: { type: 'number', description: 'Left edge in canvas coordinates.' },
      y: { type: 'number', description: 'Top edge in canvas coordinates.' },
      width: { type: 'number', description: 'Render width in pixels.' },
      height: { type: 'number', description: 'Render height in pixels.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true },
          type: { type: 'string', required: true }, x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const options = canvasOptions(active, exec)
      const binding = active.binding
      if (binding === null) throw new Error('The UI compiler canvas is not open. Open it from the project sidebar first.')
      const asset = await findAsset(binding.workspaceRoot, binding.assetDir, args.assetId)
      if (asset === undefined) throw new Error('The uploaded image is unavailable')
      const src = assetDataUrl(asset.mimeType, asset.bytes)
      if (src === undefined) throw new Error('The uploaded file is not a supported image')
      const node = {
        type: 'image', name: asset.name, src,
        width: Number.isFinite(args.width) && args.width > 0 ? args.width : 480,
        height: Number.isFinite(args.height) && args.height > 0 ? args.height : 360,
        ...(Number.isFinite(args.x) ? { x: args.x } : {}),
        ...(Number.isFinite(args.y) ? { y: args.y } : {}),
      }
      return insertCanvasNode(editorHost, node, options)
    },
    presentCall: () => ({ card: 'generic', title: 'Place uploaded image on UI canvas', kind: 'execute' }),
  })

  const editingTools=canvasToolSpecs.map(spec => defineTool({
    name:spec.name, description:spec.description, parameters:dshProperties(spec.inputSchema),
    output:{schema:{type:'object',additionalProperties:true},render:renderJson},
    async execute(args,exec) {
      const options=canvasOptions(active,exec)
      if (spec.name==='uic_canvas_edit') {
        const lastUser = exec.agent?.session?.deriveMessages?.().findLast(m => m.role === 'user' && m.source?.kind === 'user')
        const content = lastUser?.content
        const prompt = Array.isArray(content)
          ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
          : content
        options.allowDelete=canvasDeletionRequested(prompt)
        options.allowIconReplacement=canvasIconReplacementRequested(prompt)
      }
      return runCanvasTool(editorHost,options,spec.name,args)
    },
    presentCall:()=>({card:'generic',title:spec.name==='uic_canvas_read'?'Read canvas layers':'Edit canvas layers',
      kind:spec.name==='uic_canvas_read'?'read':'execute'}),
  }))
  return [select, draw, move, image, ...editingTools]
}
