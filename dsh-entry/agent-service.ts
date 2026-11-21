import { randomUUID } from 'node:crypto'
import { resolveProjectBinding } from './project-binding.mjs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { canvasAgentContribution } from './agent-wire.mjs'
import { generateCanvasDesign } from './agent-host.mjs'
import { resolveCanvasSelection } from './agent-selection.mjs'
import { readCanvasContext, applyCanvasFrame } from './agent-editor.mjs'
import { readCanvasTurns, appendCanvasTurn } from './ui-compiler-host.mjs'

// The editor and its authenticated local source grant own the document. A Remote
// caller supplies a prompt and optional DSH model choices, never paths or node data.
export function mountCanvasAgent(ctx, editorHost, workspaceRoot) {
  const contribution = canvasAgentContribution()
  ctx.effect(() => ctx.typert.register({
    package: contribution.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: contribution.descriptors,
  }), 'UI compiler: canvas agent Remote')

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'UI compiler: canvas agent lifetime')
  const sessions = new Map()
  class CanvasAgent extends TypertRemoteService {
    constructor(serviceCtx) { super(serviceCtx, 'uiCompilerCanvasAgent') }

    @Remote
    async generate(workspaceId, prompt, callerSignal) {
      return this.run(workspaceId, prompt, {}, callerSignal)
    }

    @Remote
    async generateWithOptions(workspaceId, prompt, selection, callerSignal) {
      return this.run(workspaceId, prompt, selection, callerSignal)
    }

    private async run(workspaceId, prompt, selection, callerSignal) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return { error: 'invalid_request' }
      let binding
      try { binding = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot) }
      catch { return { error: 'canvas_unavailable' } }
      let state = sessions.get(workspaceId)
      if (!state || state.sourcePath !== binding.sourcePath) {
        state = { sourcePath: binding.sourcePath, running: false }
        sessions.set(workspaceId, state)
      }
      if (state.running) return { error: 'busy' }
      state.running = true
      const timeout = AbortSignal.timeout(240000)
      const signal = AbortSignal.any([callerSignal, lifetime.signal, timeout].filter(Boolean))
      const options = { sourcePath: binding.sourcePath, ownerSessionId: binding.ownerSessionId, signal }
      try {
        const checked = await resolveCanvasSelection(ctx, selection, signal)
        if (checked.error) return { error: checked.error }
        const snapshot = await readCanvasContext(editorHost, { ...options, previousFrame: state.previousFrame })
        if (snapshot.sessionId !== state.sessionId) {
          state.previousFrame = undefined
          state.sessionId = snapshot.sessionId
          state.modelSession = randomUUID()
          state.history = []
          try {
            const turns = await readCanvasTurns(binding)
            state.history = turns.flatMap(turn => [
              { role: 'user', text: turn.prompt }, { role: 'assistant', text: turn.reply.slice(0, 8000) },
            ])
          } catch {
            ctx.logger.warn('Canvas Agent conversation could not be loaded')
          }
        }
        const design = await generateCanvasDesign({
          llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel, modelSelection: checked.modelSelection,
          prompt, history: state.history, context: snapshot.context, sessionId: state.modelSession, signal,
        })
        signal.throwIfAborted()
        const current = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot)
        if (current.sourcePath !== binding.sourcePath) return { error: 'canvas_changed' }
        let change
        if (design.frame) {
          state.previousFrame = await applyCanvasFrame(editorHost, design.frame, {
            ...options, previousFrame: state.previousFrame, snapshot, action: design.action ?? 'create',
          })
          change = { name: state.previousFrame.name, count: state.previousFrame.nodeCount, revised: design.action === 'revise' }
        }
        state.history = [...state.history, { role: 'user', text: prompt }, { role: 'assistant', text: design.reply }].slice(-12)
        let historySaved = true
        try { await appendCanvasTurn(binding, { prompt, reply: design.reply, change }) }
        catch {
          historySaved = false
          ctx.logger.warn('Canvas Agent completed a turn but its conversation could not be saved')
        }
        return { reply: design.reply, change: change ?? null, historySaved }
      } catch (error) {
        if (timeout.aborted) return { error: 'model_timeout' }
        if (signal.aborted) return { error: 'cancelled' }
        const codes = ['invalid_request', 'model_unavailable', 'model_timeout', 'model_failed', 'invalid_design',
          'canvas_changed', 'canvas_unavailable', 'revision_conflict', 'edit_failed']
        const code = codes.includes(error?.code) ? error.code : 'edit_failed'
        const diagnostic = typeof error?.diagnostic === 'string' ? error.diagnostic : ''
        ctx.logger.warn('Canvas Agent request failed (%s %s)', code, diagnostic)
        return { error: code, diagnostic }
      } finally {
        state.running = false
      }
    }
  }
  ctx.plugin(CanvasAgent)
}
