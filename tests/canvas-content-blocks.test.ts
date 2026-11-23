import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCanvasDesign } from '../dsh-entry/agent-host.mjs'

type ImageRef = { attachmentId: string; mediaType: string; width: number; height: number; bytes: number }
type Block = { type: 'text'; text: string } | { type: 'image'; attachment: ImageRef }
type Request = { messages: Array<{ role: string; content: Block[] }>; sessionId?: string }

async function* response(text: string) {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('text follow-ups keep DSH content blocks for old history, option fallback and JSON repair', async () => {
  const requests: Request[] = []
  const history = [{ role: 'user' as const, text: 'Draw a button' }, { role: 'assistant' as const, text: 'Done' }]
  const prompt = 'What did I just ask for?'
  const llm = {
    stream(request: Request) {
      requests.push(request)
      if (request.sessionId) throw new Error('session option rejected')
      return response(requests.length === 2 ? 'invalid design response' : '{"reply":"A button."}')
    },
  }
  assert.deepEqual(await generateCanvasDesign({
    llm, modelSelection: { provider: 'test', model: 'text' }, sessionId: 'old-session', prompt, history,
  }), { reply: 'A button.' })
  assert.equal(requests.length, 3)
  for (const [index, request] of requests.entries()) {
    assert.equal(request.messages.length, 1)
    const [{ role, content }] = request.messages
    assert.equal(role, 'user')
    assert.ok(Array.isArray(content), 'DSH content must be an array even when there are no images')
    assert.equal(content.length, 1)
    const [text] = content
    assert.equal(text.type, 'text')
    const data = JSON.parse(text.text)
    assert.equal(data.request, prompt)
    assert.deepEqual(data.conversation, history)
    assert.equal(Boolean(data.correction), index === 2)
  }
})

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBMsAAAAASUVORK5CYII=', 'base64')
const image = { id: 'canvas-image', name: 'sample.png', mimeType: 'image/png', bytes: bytes.length, kind: 'image', data: bytes }
const ref = { attachmentId: 'stored-image', mediaType: 'image/png', width: 1, height: 1, bytes: bytes.length }

test('vision requests preserve admitted image refs through a design repair', async () => {
  const requests: Request[] = []
  const batches: unknown[] = []
  const model = { id: 'vision', inputModalities: ['text', 'image'] }
  const llm = {
    listModels: async () => [model],
    resolveModelInfo: async () => model,
    stream(request: Request) {
      requests.push(request)
      return response(requests.length === 1 ? 'not JSON' : '{"reply":"OK"}')
    },
  }
  await generateCanvasDesign({
    llm, modelSelection: { provider: 'test', model: model.id }, prompt: 'Read this image.',
    attachments: [image],
    attachmentStore: { async saveImages(batch: unknown) { batches.push(batch); return [ref] } },
  })
  assert.deepEqual(batches, [[{ name: image.name, data: bytes, mediaType: image.mimeType }]])
  assert.equal(requests.length, 2)
  for (const request of requests) {
    const { content } = request.messages[0]
    assert.ok(Array.isArray(content))
    assert.equal(content.length, 2)
    assert.equal(content[0].type, 'text')
    assert.deepEqual(content[1], { type: 'image', attachment: ref })
    const [attachment] = JSON.parse(content[0].text).attachments
    assert.equal(attachment.data, undefined)
    assert.equal(attachment.imageInput, 'pixels')
  }
})

test('a text-only route receives a typed reference to the asset, without claiming pixel input', async () => {
  const model = { id: 'text', inputModalities: ['text'] }
  const requests: Request[] = []
  let saves = 0
  const llm = {
    listModels: async () => [model],
    resolveModelInfo: async () => model,
    stream(request: Request) { requests.push(request); return response('{"reply":"Reference available"}') },
  }
  await generateCanvasDesign({
    llm, modelSelection: { provider: 'test', model: model.id }, prompt: 'Use the uploaded asset.', attachments: [image],
    attachmentStore: { async saveImages() { saves++; return [ref] } },
  })
  assert.equal(saves, 0)
  assert.equal(requests.length, 1)
  const content = requests[0].messages[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  const [attachment] = JSON.parse(content[0].text).attachments
  assert.equal(attachment.id, image.id)
  assert.equal(attachment.imageInput, 'reference-only')
  assert.equal(attachment.data, undefined)
})

test('if vision image admission fails, the turn fails before a model request is made', async () => {
  const model = { id: 'vision', inputModalities: ['text', 'image'] }
  let calls = 0
  const llm = {
    listModels: async () => [model],
    resolveModelInfo: async () => model,
    stream() { calls++; return response('{"reply":"ok"}') },
  }
  await assert.rejects(generateCanvasDesign({
    llm, modelSelection: { provider: 'test', model: model.id }, sessionId: 'with-retry',
    prompt: 'Describe the image', attachments: [image],
    attachmentStore: { async saveImages() { throw new Error('unsupported image bytes') } },
  }), { code: 'image_attachment_failed' })
  assert.equal(calls, 0)
})
