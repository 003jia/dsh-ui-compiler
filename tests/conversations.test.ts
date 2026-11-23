import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeConversation, appendConversationTurn, createConversation, listConversations, selectConversation,
} from '../dsh-entry/conversations.mjs'

async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uic-conversations-')))
  return {
    root,
    binding: {
      workspaceRoot: root, sourcePath: join(root, 'design/pages/ui.op'),
      canvasFile: 'design/pages/ui.op', historyFile: 'ui.history.json',
    },
  }
}

test('the legacy single history becomes the first conversation', async () => {
  const { root, binding } = await project()
  try {
    await mkdir(join(root, '.dsh/ui-compiler'), { recursive: true })
    await writeFile(join(root, '.dsh/ui-compiler/ui.history.json'), JSON.stringify({
      version: 1, document: 'design/pages/ui.op',
      turns: [{ prompt: 'first prompt', reply: 'first reply' }, { prompt: 'second prompt', reply: 'second reply' }],
    }))
    const state = await listConversations(binding)
    assert.equal(state.conversations.length, 1)
    assert.equal(state.conversations[0].title, 'first prompt')
    assert.equal(state.conversations[0].turnCount, 2)
    const active = await activeConversation(binding)
    assert.equal(active.turns.length, 2)
    assert.equal(active.turns[1].reply, 'second reply')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('append titles the active conversation and new/select switch it', async () => {
  const { root, binding } = await project()
  try {
    const initial = await activeConversation(binding)
    assert.equal(initial.turns.length, 0)
    const summary = await appendConversationTurn(binding, { prompt: '  Make a settings page  ', reply: 'Ready', change: { name: 'Settings', revised: false } })
    assert.equal(summary.title, 'Make a settings page')
    assert.equal(summary.turnCount, 1)

    const created = await createConversation(binding)
    assert.notEqual(created.id, initial.id)
    assert.equal((await activeConversation(binding)).id, created.id)
    const list = await listConversations(binding)
    assert.equal(list.conversations.length, 2)
    assert.equal(list.activeId, created.id)

    const selected = await selectConversation(binding, initial.id)
    assert.equal(selected.id, initial.id)
    assert.equal(selected.turns.length, 1)
    assert.equal((await activeConversation(binding)).id, initial.id)
    await assert.rejects(selectConversation(binding, 'missing'), /not found/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('turns are bounded and persisted in the project', async () => {
  const { root, binding } = await project()
  try {
    await activeConversation(binding)
    for (let index = 0; index < 70; index++) {
      await appendConversationTurn(binding, { prompt: `prompt ${index}`, reply: `reply ${index}` })
    }
    const active = await activeConversation(binding)
    assert.equal(active.turns.length, 60)
    assert.equal(active.turns.at(-1)?.prompt, 'prompt 69')
    const file = JSON.parse(await readFile(join(root, '.dsh/ui-compiler/conversations.json'), 'utf8'))
    assert.equal(file.version, 1)
    assert.equal(file.activeId, active.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('persisted design-tool receipts retain bounded display fields and omit raw tool payloads', async () => {
  const {root, binding} = await project()
  try {
    const first = await activeConversation(binding)
    const toolCalls = [
      {name: 'uic_canvas_read', status: 'success', target: '保存按钮', args: 'raw private input', result: 'raw private document'},
      {name: 'uic_canvas_edit', status: 'error', target: 'a'.repeat(200), summary: 'b'.repeat(200)},
      {name: 'future_or_unrelated_tool', status: 'success'}, {name: 'uic_canvas_read', status: 'unknown'},
    ]
    await appendConversationTurn(binding, {prompt: 'edit', reply: 'retry', failed: true, toolCalls} as any, first.id)
    await createConversation(binding)
    const stored = (await selectConversation(binding, first.id)).turns[0]
    assert.deepEqual(stored.toolCalls, [
      {name: 'uic_canvas_read', status: 'success', target: '保存按钮'},
      {name: 'uic_canvas_edit', status: 'error', target: 'a'.repeat(96), summary: 'b'.repeat(140)},
    ])
    assert.equal(stored.failed, true)
    const saved = await readFile(join(root, '.dsh/ui-compiler/conversations.json'), 'utf8')
    assert.doesNotMatch(saved, /raw private|future_or_unrelated_tool/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a retried follow-up updates its failed turn without appending duplicate history', async () => {
  const {root,binding} = await project()
  try {
    const {id} = await activeConversation(binding)
    const batchId = 'b988a9b2-c41f-4137-8e73-b84b54d33a72'
    await appendConversationTurn(binding,{batchId,prompt:'edit',reply:'one still queued',failed:true},id)
    await appendConversationTurn(binding,{batchId,prompt:'edit',reply:'queue drained; one failed',failed:true},id)
    const {turns} = await activeConversation(binding)
    assert.equal(turns.length,1)
    assert.equal(turns[0].failed,true)
    assert.equal(turns[0].reply,'queue drained; one failed')
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})
