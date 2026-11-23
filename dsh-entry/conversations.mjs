import { constants } from 'node:fs'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectDirectory } from './project-binding.mjs'

// Canvas conversations are project-local records. The design document is
// shared; only the assistant transcript is partitioned. Files are replaced
// atomically and every read revalidates the bounds.

const FILE = 'conversations.json'
const MAX_CONVERSATIONS = 20
const MAX_TURNS = 60
const MAX_FILE_BYTES = 640 * 1024
const MAX_TITLE = 80

function now() {
  return new Date().toISOString()
}

function conversation(title = '') {
  return { id: randomUUID(), title, createdAt: now(), updatedAt: now(), turns: [] }
}

// Persist only bounded, host-generated display receipts. Tool arguments, results,
// selection snapshots and adapter diagnostics never belong in the transcript.
const canvasToolNames = new Set(['uic_canvas_read', 'uic_canvas_edit', 'uic_canvas_place', 'uic_update_plan'])
function receiptLabel(value, limit) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit)
}

export function cleanCanvasToolCalls(value) {
  if (!Array.isArray(value)) return []
  const calls = []
  for (const call of value.slice(0, 64)) {
    if (!call || !canvasToolNames.has(call.name) || !['success', 'error'].includes(call.status)) continue
    const target = receiptLabel(call.target, 96)
    const summary = receiptLabel(call.summary, 140)
    calls.push({name: call.name, status: call.status, ...(target ? {target} : {}), ...(summary ? {summary} : {}),
      ...(Number.isInteger(call.agentIndex) && call.agentIndex >= 1 && call.agentIndex <= 6 ? {agentIndex:call.agentIndex} : {}),
      ...(Number.isInteger(call.round) && call.round >= 0 && call.round <= 5 ? {round:call.round} : {}),
      ...(typeof call.additionId === 'string' && /^[a-f0-9-]{36}$/i.test(call.additionId) ? {additionId:call.additionId} : {}),
      ...(call.name === 'uic_canvas_place' ? {source:'editor'} : {}),
    })
  }
  return calls
}

function cleanPlan(value, toolCalls) {
  if (!value || !Array.isArray(value.slots) || !value.slots.length) return
  const states = new Set(['queued','running','writing','done','failed'])
  const status = item => states.has(item) ? item : 'failed'
  const slots = value.slots.slice(0,6).map((s,i) => ({
    ...(Number.isFinite(s?.elapsedMs) ? {elapsedMs:Math.max(0,Math.round(s.elapsedMs))} : {}),
    ...(typeof s?.model?.provider==='string' && typeof s.model.model==='string'
      ? {model:{provider:receiptLabel(s.model.provider,160),model:receiptLabel(s.model.model,200)},modelLabel:receiptLabel(s.modelLabel || s.model.model,200)} : {}),
    index:i+1, round:Number.isInteger(s?.round) ? Math.min(5,Math.max(0,s.round)) : 0,
    title:receiptLabel(s?.title,100), scope:receiptLabel(s?.scope,620), status:status(s?.status),
    ...(Array.isArray(s?.tasks) && s.tasks.length ? {tasks:s.tasks.slice(0,6)
      .filter(task=>task && ['queued','running','done'].includes(task.status) && typeof task.title==='string')
      .map(task=>({title:receiptLabel(task.title,100),status:task.status}))} : {}),
    toolCalls:toolCalls.filter(call=>call.agentIndex === i+1),
  }))
  const additions = (Array.isArray(value.additions) ? value.additions : []).slice(0,8)
    .filter(a=>typeof a?.id==='string' && /^[a-f0-9-]{36}$/i.test(a.id) && typeof a.text==='string')
    .map(a=>({id:a.id, text:a.text.slice(0,2000), status:status(a.status),
      ...(Number.isFinite(a.elapsedMs) ? {elapsedMs:Math.max(0,Math.round(a.elapsedMs))} : {}),
      ...(typeof a.model?.provider==='string' && typeof a.model.model==='string' ? {model:{provider:receiptLabel(a.model.provider,160),model:receiptLabel(a.model.model,200)}} : {}),
      ...(a.reply ? {reply:receiptLabel(a.reply,2000)} : {})}))
  const steps = (Array.isArray(value.steps) ? value.steps : []).slice(0,6).map(s=>({title:receiptLabel(s?.title,96),status:status(s?.status)}))
  return {phase:value.phase==='done' ? 'done' : 'failed',slots,steps,additions,
    ...(Number.isFinite(value.elapsedMs) ? {elapsedMs:Math.max(0,Math.round(value.elapsedMs))} : {}),
    total: Math.max(1,Math.min(36,Number(value.total)||1)), completed:Math.max(0,Math.min(36,Number(value.completed)||0))}
}

function cleanTurn(turn) {
  if (turn === null || typeof turn !== 'object') return undefined
  const prompt = typeof turn.prompt === 'string' ? turn.prompt.slice(0, 8000) : ''
  const reply = typeof turn.reply === 'string' ? turn.reply.slice(0, 9000) : ''
  if (prompt === '' || reply === '') return undefined
  const change = turn.change && typeof turn.change.name === 'string' && typeof turn.change.revised === 'boolean'
    ? { name: turn.change.name.slice(0, 240), revised: turn.change.revised }
    : undefined
  const penAssetIds = Array.isArray(turn.penAssetIds)
    ? [...new Set(turn.penAssetIds.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)))].slice(0, 6)
    : []
  const batchId = typeof turn.batchId === 'string' && /^[a-f0-9-]{36}$/i.test(turn.batchId) ? turn.batchId : undefined
  const toolCalls = cleanCanvasToolCalls(turn.toolCalls)
  const plan = cleanPlan(turn.plan, toolCalls)
  return { prompt, reply, ...(plan ? {plan} : {}), ...(turn.failed === true ? {failed: true} : {}), ...(toolCalls.length ? {toolCalls} : {}), ...(batchId ? { batchId } : {}), ...(change ? { change } : {}), ...(penAssetIds.length ? { penAssetIds } : {}) }
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TITLE) : ''
}

function cleanState(parsed) {
  const conversations = Array.isArray(parsed?.conversations)
    ? parsed.conversations.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .slice(-MAX_CONVERSATIONS)
      .map(entry => ({
        id: entry.id,
        title: cleanTitle(entry.title),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now(),
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now(),
        turns: (Array.isArray(entry.turns) ? entry.turns : []).map(cleanTurn).filter(Boolean).slice(-MAX_TURNS),
      }))
    : []
  const activeId = conversations.some(entry => entry.id === parsed?.activeId)
    ? parsed.activeId
    : conversations.at(-1)?.id
  return { version: 1, activeId, conversations }
}

async function legacyTurns(binding) {
  try {
    const directory = await projectDirectory(binding.workspaceRoot, ['.dsh', 'ui-compiler'], false)
    const file = await open(join(directory, binding.historyFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return []
      const saved = JSON.parse(await file.readFile('utf8'))
      return (Array.isArray(saved?.turns) ? saved.turns : []).map(cleanTurn).filter(Boolean).slice(-MAX_TURNS)
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
}

async function writeState(binding, state) {
  const directory = await projectDirectory(binding.workspaceRoot, ['.dsh', 'ui-compiler'], true)
  const text = JSON.stringify(state)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw Object.assign(new Error('Conversation history is too large'), { code: 'too_large' })
  const temporary = join(directory, FILE + '.' + randomUUID())
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    try { await file.writeFile(text) } finally { await file.close() }
    await rename(temporary, join(directory, FILE))
  } finally {
    await rm(temporary, { force: true })
  }
}

const writes = new Map()

function serialize(binding, operation) {
  const key = binding.sourcePath
  const previous = writes.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation).finally(() => {
    if (writes.get(key) === next) writes.delete(key)
  })
  writes.set(key, next)
  return next
}

async function readState(binding) {
  let parsed
  try {
    const directory = await projectDirectory(binding.workspaceRoot, ['.dsh', 'ui-compiler'], false)
    const text = await readFile(join(directory, FILE), 'utf8')
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Conversation file is too large')
    parsed = JSON.parse(text)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let state = parsed === undefined ? { version: 1, activeId: undefined, conversations: [] } : cleanState(parsed)
  if (state.conversations.length === 0) {
    const turns = await legacyTurns(binding)
    const first = conversation(turns[0]?.prompt ?? '')
    first.turns = turns
    state = { version: 1, activeId: first.id, conversations: [first] }
    await writeState(binding, state)
  }
  if (!state.conversations.some(entry => entry.id === state.activeId)) {
    state.activeId = state.conversations.at(-1).id
  }
  return state
}

function summary(entry) {
  return { id: entry.id, title: entry.title, updatedAt: entry.updatedAt, turnCount: entry.turns.length }
}

/** List conversation summaries and the active identity. */
export function listConversations(binding) {
  return serialize(binding, async () => {
    const state = await readState(binding)
    return { activeId: state.activeId, conversations: state.conversations.map(summary) }
  })
}

/** Read the full active conversation. */
export function activeConversation(binding) {
  return serialize(binding, async () => {
    const state = await readState(binding)
    const active = state.conversations.find(entry => entry.id === state.activeId)
    return { id: active.id, title: active.title, turns: active.turns }
  })
}

/** Create and activate a fresh conversation. */
export function createConversation(binding) {
  return serialize(binding, async () => {
    const state = await readState(binding)
    if (state.conversations.length >= MAX_CONVERSATIONS) {
      throw Object.assign(new Error('Too many conversations'), { code: 'too_many_conversations' })
    }
    const next = conversation()
    state.conversations.push(next)
    state.activeId = next.id
    await writeState(binding, state)
    return { id: next.id, title: next.title, turns: next.turns, activeId: state.activeId }
  })
}

/** Activate one existing conversation. */
export function selectConversation(binding, id) {
  return serialize(binding, async () => {
    if (typeof id !== 'string' || id.length === 0) throw Object.assign(new Error('Invalid conversation'), { code: 'invalid_conversation' })
    const state = await readState(binding)
    const selected = state.conversations.find(entry => entry.id === id)
    if (selected === undefined) throw Object.assign(new Error('Conversation not found'), { code: 'invalid_conversation' })
    state.activeId = selected.id
    await writeState(binding, state)
    return { id: selected.id, title: selected.title, turns: selected.turns, activeId: state.activeId }
  })
}

/** Append a turn to its originating conversation, including after a mid-request switch. */
export function appendConversationTurn(binding, turn, conversationId) {
  return serialize(binding, async () => {
    const cleaned = cleanTurn(turn)
    if (cleaned === undefined) throw Object.assign(new Error('Invalid conversation turn'), { code: 'invalid_conversation' })
    const state = await readState(binding)
    const active = state.conversations.find(entry => entry.id === (conversationId ?? state.activeId))
    if (!active) throw Object.assign(new Error('Conversation not found'), { code: 'invalid_conversation' })
    const index = cleaned.batchId ? active.turns.findIndex(turn => turn.batchId === cleaned.batchId) : -1
    if (index < 0) active.turns = [...active.turns, cleaned].slice(-MAX_TURNS)
    else {
      const previous = active.turns[index]
      if (!previous.failed || previous.prompt !== cleaned.prompt) return summary(active)
      active.turns[index] = cleaned
    }
    active.updatedAt = now()
    if (active.title === '') active.title = cleaned.prompt.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE)
    await writeState(binding, state)
    return summary(active)
  })
}

/** Read only the active conversation's turns for the canvas route. */
export async function readActiveTurns(binding) {
  return (await activeConversation(binding)).turns
}

export const CONVERSATION_LIMITS = { conversations: MAX_CONVERSATIONS, turns: MAX_TURNS, file: MAX_FILE_BYTES }
