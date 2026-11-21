import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const { resolveCanvasSelection } = await import(new URL('../dsh-entry/agent-selection.mjs', import.meta.url).href)
const wire = await readFile(new URL('../dsh-entry/agent-wire.js', import.meta.url), 'utf8')
const descriptors = runInNewContext(wire + '\ncanvasAgentContribution().descriptors')
const parser = descriptors.find((entry: { method: string }) => entry.method === 'generateWithOptions').parameters[2].codec.create()
const signal = new AbortController().signal
const ctx = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'a', model: 'm', reasoningEffort: 'deep' }) },
  llm: {
    listProviders: () => [{ id: 'a' }, { id: 'b' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async (provider: string) => provider === 'a'
      ? { reasoning: { efforts: [{ id: 'fast' }, { id: 'deep' }] } }
      : {},
  },
}

test('the canvas protocol keeps existing calls and permits only complete route overrides', () => {
  assert.equal(descriptors[0].method, 'generate')
  assert.equal(descriptors[0].parameters.length, 2)
  for (const invalid of [null, [], { model: 'm' }, { provider: 'a' }, { provider: ' ' }, { reasoningEffort: 1 }, { apiKey: 'x' }]) {
    assert.throws(() => parser.parse(invalid), /Invalid canvas model selection/)
  }
  for (const valid of [{}, { reasoningEffort: 'fast' }, { provider: 'b', model: 'm' }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(parser.parse(valid))), valid)
  }
})

test('canvas overrides validate the exact adapter and never transfer an old reasoning effort', async () => {
  assert.deepEqual(await resolveCanvasSelection(ctx, {}, signal), {})
  assert.deepEqual(await resolveCanvasSelection(ctx, { reasoningEffort: 'fast' }, signal), {
    modelSelection: { provider: 'a', model: 'm', reasoningEffort: 'fast' },
  })
  assert.deepEqual(await resolveCanvasSelection(ctx, { provider: 'b', model: 'm' }, signal), {
    modelSelection: { provider: 'b', model: 'm' },
  })
  assert.deepEqual(await resolveCanvasSelection(ctx, { provider: 'b', model: 'm', reasoningEffort: 'deep' }, signal), { error: 'unsupported_effort' })
  assert.deepEqual(await resolveCanvasSelection(ctx, { provider: 'b', model: 'missing' }, signal), { error: 'model_unavailable' })
  assert.deepEqual(await resolveCanvasSelection(ctx, { provider: 'missing', model: 'm' }, signal), { error: 'model_unavailable' })
})

test('cancels an outstanding adapter catalog check', async () => {
  const controller = new AbortController()
  const blocked = { ...ctx, llm: { ...ctx.llm, listModels: () => new Promise(() => {}) } }
  const result = resolveCanvasSelection(blocked, { provider: 'b', model: 'm' }, controller.signal)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
})
