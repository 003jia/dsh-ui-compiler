import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'vite'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const { buildSavedCompilerPreview } = await import(new URL('../dsh-entry/preview-build.mjs', import.meta.url).href)
const card = {
  id: 'connection-card', type: 'frame', name: '连接助手', layout: 'vertical',
  children: [
    { id: 'heading', type: 'text', name: '标题', content: '项目连接助手' },
    { id: 'check-connection', type: 'frame', name: '检查按钮', children: [
      { id: 'label', type: 'text', name: '按钮文字', content: '立即检查' },
    ] },
  ],
}

async function buildProject(t: TestContext, design: unknown, canvasFile: string) {
  const root = await mkdtemp(join(tmpdir(), 'uic-frontend-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dependencyRoot = join(root, 'node_modules')
  await symlink(join(projectRoot, 'node_modules'), dependencyRoot, 'dir')
  const source = Buffer.from(JSON.stringify(design))
  const inputHash = createHash('sha256').update(source).digest('hex')
  const options = { snapshotRoot: projectRoot, dependencyRoot, source, inputHash, canvasFile }
  const [preview, exported] = await Promise.all([
    buildSavedCompilerPreview(options),
    buildSavedCompilerPreview({ ...options, exportSource: true }),
  ])
  assert.equal(preview.inputHash, inputHash)
  assert.equal(exported.inputHash, inputHash)
  const payload = /<script type="application\/json" id="uic-saved-frames">([\s\S]*?)<\/script>/.exec(preview.html)
  assert.ok(payload)
  const files = exported.files as Record<string, string>
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents)
  await build({
    root,
    // Use the same installed DSH controls for calibration exports as the desktop preview.
    configFile: join(projectRoot, 'harness/vite.config.ts'),
    logLevel: 'silent',
    build: {
      lib: {
        entry: join(root, 'UiPage.tsx'), formats: ['es'],
        fileName: () => 'ui-page.mjs', cssFileName: 'ui-page',
      },
      rollupOptions: { external: ['react', 'react/jsx-runtime'] },
    },
  })
  const bundle = await import(pathToFileURL(join(root, 'dist/ui-page.mjs')).href)
  return { html: preview.html as string, previewBoards: JSON.parse(payload[1]), files, bundle }
}

// Walk the native React elements returned by CanvasFramePreview to exercise its button handler.
function clickLayer(tree: ReactNode, id: string): boolean {
  if (!isValidElement<{ children?: ReactNode; 'data-layer-id'?: string; onClick?: () => void }>(tree)) return false
  if (tree.type === 'button' && tree.props['data-layer-id'] === id) {
    assert.equal(typeof tree.props.onClick, 'function')
    tree.props.onClick!()
    return true
  }
  return Children.toArray(tree.props.children).some(child => clickLayer(child, id))
}

test('a project previews and exports its own native boards and dispatches button actions by layer ID', async t => {
  // A regular project's board may have the same display name as the calibration board.
  const first = { id: 'first', type: 'frame', name: 'MCP 中心/default', children: [
    { id: 'first-title', type: 'text', content: '项目里的同名画板' },
  ] }
  const hidden = { ...card, id: 'hidden-board', hidden: true }
  const design = { pages: [{ children: [first] }, { children: [hidden, card] }] }
  const { html, previewBoards, files, bundle } = await buildProject(t, design, 'design/pages/ui.op')
  assert.deepEqual(previewBoards, [first, card])
  assert.doesNotMatch(html, /team-notes|doc-index/)
  assert.deepEqual(Object.keys(files).sort(), ['CanvasFramePreview.tsx', 'UiPage.tsx', 'boards.json'])
  assert.deepEqual(bundle.boards, previewBoards)
  const UiPage = bundle.default
  const markup = renderToStaticMarkup(createElement(UiPage))
  assert.match(markup, /项目连接助手/)
  assert.match(markup, /<button\b[^>]*data-layer-id="check-connection"[^>]*><span[^>]*>立即检查<\/span><\/button>/)
  assert.match(renderToStaticMarkup(createElement(UiPage, { boardId: first.id })), /项目里的同名画板/)
  assert.equal(renderToStaticMarkup(createElement(UiPage, { boardId: hidden.id })), '')

  const actions: unknown[] = []
  const frame = UiPage({ boardId: card.id, onAction: (action: unknown) => actions.push(action) })
  assert.ok(clickLayer(frame.type(frame.props), 'check-connection'))
  assert.deepEqual(actions, [{ id: 'check-connection', name: '检查按钮' }])
})

test('the calibration export keeps its compiled MCP view, accepts host data, and includes custom boards', async t => {
  const design = JSON.parse(await readFile(join(projectRoot, 'design/pages/mcp-center.op'), 'utf8'))
  const calibrationBoards = design.children.filter((board: { name: string }) =>
    board.name.startsWith('MCP 中心/') || board.name.startsWith('_'))
  const base = calibrationBoards.find((board: { name: string }) => board.name === 'MCP 中心/default')
  const { html, previewBoards, files, bundle } = await buildProject(t, { ...design, children: [...calibrationBoards, card] }, 'design/pages/mcp-center.op')
  assert.deepEqual(previewBoards, [card])
  assert.match(html, /team-notes/)
  assert.doesNotMatch(Object.values(files).join('\n'), /team-notes|doc-index/)
  assert.equal(bundle.compiledBoardId, base.id)
  const selected = renderToStaticMarkup(createElement(bundle.default, {
    boardId: bundle.compiledBoardId,
    mcpProps: { servers: [{ id: 'real-service', name: '项目提供的服务', previewRowIndex: 0 }] },
  }))
  assert.match(selected, /项目提供的服务/)
  assert.doesNotMatch(selected, /项目连接助手/)
  assert.match(renderToStaticMarkup(createElement(bundle.default)), /项目连接助手/)
})
