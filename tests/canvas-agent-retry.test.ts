import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCanvasDesign } from '../dsh-entry/agent-host.mjs'

const frame = {
  type: 'frame', name: 'Card', width: 200, height: 120, layout: 'vertical',
  children: [{ type: 'text', name: 'Title', content: 'Hello', width: 100, height: 20 }],
}
const reply = JSON.stringify({ reply: 'Ready', action: 'create', frame })

function stream(text: string) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

test('a rejected reasoning effort retries once with provider defaults', async () => {
  const calls: Array<any> = []
  const llm = {
    stream(options: any) {
      calls.push(options)
      if (options.reasoningEffort !== undefined || options.sessionId !== undefined) throw new Error('provider rejects request options')
      return stream(reply)
    },
  }
  const design = await generateCanvasDesign({
    llm, modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    prompt: 'make a card', context: { pageName: 'Page', frames: [] }, sessionId: 'session-1',
  })
  assert.equal(design.action, 'create')
  assert.equal((design.frame as { name?: string }).name, 'Card')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoningEffort, 'max')
  assert.equal(calls[0].sessionId, 'session-1')
  assert.equal(calls[1].reasoningEffort, undefined)
  assert.equal(calls[1].sessionId, undefined)
})

test('a provider failure on both variants keeps the route and fails once', async () => {
  let calls = 0
  const llm = { stream() { calls += 1; throw Object.assign(new Error('HTTP 503 upstream unavailable'), { code: 'UNKNOWN' }) } }
  await assert.rejects(
    generateCanvasDesign({
      llm, modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      prompt: 'make a card', context: {}, sessionId: 'session-1',
    }),
    error => {
      const failure = error as { code?: string; diagnostic?: string }
      return failure.code === 'model_failed' && /p\/m · high/u.test(failure.diagnostic ?? '') && /HTTP 503|upstream unavailable/u.test(failure.diagnostic ?? '')
    },
  )
  assert.equal(calls, 2)
})
