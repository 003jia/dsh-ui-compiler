import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const { buildSavedCompilerPreview } = await import(new URL('../dsh-entry/preview-build.mjs', import.meta.url).href)

test('packages only visible additional boards and renders their saved button labels', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'uic-frame-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const dependencies = join(temporary, 'node_modules')
  await symlink(join(projectRoot, 'node_modules'), dependencies, 'dir')

  const design = JSON.parse(await readFile(join(projectRoot, 'design/pages/mcp-center.op'), 'utf8'))
  const baseNames = new Set([
    'MCP 中心/default', 'MCP 中心/loading', 'MCP 中心/empty', 'MCP 中心/error',
    '_组件库', '_搜索无结果', '_窄容器', '_变量清单',
  ])
  const originalBoards = design.children.filter((frame: { name: string }) => baseNames.has(frame.name))
  assert.equal(originalBoards.length, baseNames.size)

  const card = {
    id: 'fixture-card', type: 'frame', name: '回归用卡片', width: 320, height: 180, layout: 'vertical',
    children: [
      { id: 'fixture-title', type: 'text', name: '标题', content: '延迟 < 100 ms </script>' },
      { id: 'fixture-button', type: 'frame', name: '旧名字按钮', layout: 'horizontal', children: [
        { id: 'fixture-label', type: 'text', name: '按钮文字', content: '复测连接' },
      ] },
    ],
  }
  const excluded = [
    { id: 'hidden', hidden: true }, { id: 'invisible', visible: false },
    { id: 'disabled', enabled: false }, { id: 'reusable', reusable: true },
  ].map(entry => ({ ...entry, type: 'frame', name: entry.id, width: 40, height: 40 }))
  const source = Buffer.from(JSON.stringify({ ...design, children: [...originalBoards, ...excluded, card] }))
  const inputHash = createHash('sha256').update(source).digest('hex')
  const preview = await buildSavedCompilerPreview({
    snapshotRoot: projectRoot, dependencyRoot: dependencies, source, inputHash,
  })
  assert.equal(preview.inputHash, inputHash)
  const payload = /<script type="application\/json" id="uic-saved-frames">([\s\S]*?)<\/script>/.exec(preview.html)
  assert.ok(payload, 'Final HTML should contain the saved-frame data')
  assert.doesNotMatch(payload[1], /</)
  const frames = JSON.parse(payload[1])
  assert.deepEqual(frames, [card])

  // Use the same renderer as the preview entry, with the data extracted from the packaged page.
  const rendererFile = join(temporary, 'CanvasFramePreview.mjs')
  const rendererSource = await readFile(join(projectRoot, 'harness/src/CanvasFramePreview.tsx'), 'utf8')
  const compiled = ts.transpileModule(rendererSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  })
  await writeFile(rendererFile, compiled.outputText)
  const { CanvasFramePreview } = await import(pathToFileURL(rendererFile).href)
  const markup = renderToStaticMarkup(createElement(CanvasFramePreview, { frame: frames[0] }))
  assert.match(markup, /role="heading"[^>]*>延迟 &lt; 100 ms &lt;\/script&gt;<\/span>/)
  assert.match(markup, /<button\b[^>]*><span[^>]*>复测连接<\/span><\/button>/)
})
