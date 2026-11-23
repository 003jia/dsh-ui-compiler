import { taskPlanSpec, updateTaskPlan } from './task-plan.mjs'
import { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { canvasDeletionRequested, canvasIconReplacementRequested, canvasToolSpecs, runCanvasTool } from './canvas-tools.mjs'
import { randomUUID } from 'node:crypto'
import { resolveProjectBinding } from './project-binding.mjs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { canvasAgentContribution } from './agent-wire.mjs'
import { describeImportedPage, summarizeImportedNode } from './pen-context.mjs'
import { generateCanvasDesign, resolveCanvasAttachments } from './agent-host.mjs'
import { resolveCanvasSelection, resolveParallelModels } from './agent-selection.mjs'
import { readCanvasContext, applyCanvasFrame, applyParallelFrames, prepareAgentWorkAreas, resolveAgentWorkTarget } from './agent-editor.mjs'
import { generateParallelDesigns, openParallelJob, parallelProgress, queueCanvasInstruction, drainCanvasInstructions, wantsParallelEdits } from './parallel-agent.mjs'
import { activeConversation, appendConversationTurn } from './conversations.mjs'

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
    async generate(workspaceId, prompt, attachments, callerSignal) {
      return this.run(workspaceId, prompt, {}, attachments, callerSignal)
    }

    @Remote
    async generateWithOptions(workspaceId, prompt, selection, attachments, callerSignal) {
      return this.run(workspaceId, prompt, selection, attachments, callerSignal)
    }

    @Remote
    async generateFromCanvas(workspaceId, prompt, selection, attachments, visualSelection, callerSignal) {
      return this.run(workspaceId, prompt, selection, attachments, callerSignal, visualSelection)
    }

    @Remote
    async generateWithTools(workspaceId, prompt, selection, attachments, visualSelection, requestId, callerSignal) {
      return this.run(workspaceId, prompt, selection, attachments, callerSignal, visualSelection, undefined, requestId)
    }

    @Remote
    async generateParallel(workspaceId, prompt, selection, attachments, visualSelection, plan, callerSignal) {
      return this.run(workspaceId, prompt, selection, attachments, callerSignal, visualSelection, plan)
    }

    @Remote
    async parallelProgress(workspaceId, requestId) {
      const state = sessions.get(workspaceId)
      const job = state?.jobs?.get(requestId)
      if (!job) return null
      const binding = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot)
      if (binding.sourcePath !== state.sourcePath || (await activeConversation(binding)).id !== job.conversationId) return null
      return parallelProgress(job)
    }

    @Remote
    async appendInstruction(workspaceId, requestId, additionId, prompt) {
      const state = sessions.get(workspaceId)
      const job = state?.jobs?.get(requestId)
      if (!job) return {error:state?.running ? 'starting' : 'closed'}
      const binding = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot)
      if (state !== sessions.get(workspaceId) || binding.sourcePath !== state.sourcePath ||
          (await activeConversation(binding)).id !== job.conversationId) return {error:'canvas_changed'}
      return queueCanvasInstruction(job, additionId, prompt)
    }

    private async run(workspaceId, prompt, selection, attachments, callerSignal, visualSelection = undefined, plan = undefined, toolRequestId = undefined) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return { error: 'invalid_request' }
      let binding
      try { binding = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot) }
      catch { return { error: 'canvas_unavailable' } }
      let state = sessions.get(workspaceId)
      if (!state || state.sourcePath !== binding.sourcePath) {
        state = { sourcePath: binding.sourcePath, running: false, jobs: new Map() }
        sessions.set(workspaceId, state)
      }
      if (state.running) return { error: 'busy' }
      let conversation
      try { conversation = await activeConversation(binding) }
      catch { return { error: 'canvas_unavailable' } }
      if (state.running) return { error: 'busy' }
      if (state.conversationId !== conversation.id) {
        state.conversationId = conversation.id
        state.previousFrame = undefined
        state.modelSession = randomUUID()
        state.history = conversation.turns.flatMap(turn => [
          { role: 'user', text: turn.prompt }, { role: 'assistant', text: turn.reply.slice(0, 8000) },
          ...(turn.plan?.additions ?? []).filter(a=>a.status==='done' && a.reply).flatMap(a=>[
            {role:'user',text:a.text},{role:'assistant',text:a.reply},
          ]),
        ])
      }
      // A client repeating the same submission after a lost response must see
      // the recorded result rather than apply its edit a second time.
      const requestStartedAt = performance.now()
      const requestId = plan?.requestId ?? toolRequestId
      if (requestId) {
        const saved = conversation.turns.find(turn => turn.batchId === requestId)
        if (saved && saved.prompt !== prompt) return {error:'invalid_request'}
        if (saved && !saved.failed) return {...saved, historySaved:true}
        // Confirmed writes from an interrupted base task or a follow-up must
        // not be replayed after the live job has gone. Follow-ups start only
        // after the base tasks have counted as completed in the progress plan.
        if (saved?.failed && !state.jobs.has(requestId)) {
          return {error:saved.plan?.completed === 0 ? 'partial_base' : 'partial_followup',plan:saved.plan,toolCalls:saved.toolCalls}
        }
        if (toolRequestId && state.lastToolTurn?.id === toolRequestId && state.lastToolTurn.conversation === conversation.id) {
          return state.lastToolTurn.prompt === prompt ? state.lastToolTurn.result : {error:'invalid_request'}
        }
      }
      let toolCalls = []
      state.running = true
      let job
      // Each model call has its own deadline. Reserve time for the bounded
      // queue of eight user additions, which can arrive during the base turn.
      const timeout = AbortSignal.timeout(((plan?.iterations ?? 0) + 10) * 210_000 + 30000)
      const signal = AbortSignal.any([callerSignal, lifetime.signal, timeout].filter(Boolean))
      const options = { sourcePath: binding.sourcePath, ownerSessionId: binding.ownerSessionId, signal }
      try {
        const checked = await resolveCanvasSelection(ctx, selection, signal)
        if (checked.error) return { error: checked.error }
        const previousPenIds = conversation.turns.findLast(turn => turn.penAssetIds?.length)?.penAssetIds ?? []
        const uploaded = await resolveCanvasAttachments(binding, attachments, prompt, previousPenIds)
        if (uploaded === undefined) return { error: 'invalid_request' }
        const snapshot = await readCanvasContext(editorHost, {
          ...options, visualSelection, sessionId: visualSelection?.sessionId, previousFrame: state.previousFrame,
          summarizeImported: summarizeImportedNode,
          describePage: (children, selectedIds) => describeImportedPage(children, selectedIds, prompt),
        })
        if (snapshot.sessionId !== state.sessionId) {
          state.previousFrame = undefined
          state.sessionId = snapshot.sessionId
          state.modelSession = randomUUID()
        }
        const jobPlan = plan ?? {count:1,iterations:0,requestId:requestId ?? randomUUID()}
        job = openParallelJob(state.jobs, jobPlan,
          [prompt, selection, attachments.map(a => a.id), visualSelection ?? null, plan ?? null], snapshot, conversation.id)
        if (job.result) return job.result
        job.startedAt = requestStartedAt
        delete job.finishedAt
        job.accepting = true
        toolCalls = job.receipts ??= []
        const liveOptions = {...options, snapshot, visualSelection}
        job.workAreas ??= await prepareAgentWorkAreas(editorHost, jobPlan.count, liveOptions)
        for (const slot of job.slots) {
          const area = job.workAreas[slot.index - 1]
          if (area && !Number.isFinite(slot.x)) Object.assign(slot,{x:area.x,y:area.y})
        }
        const common = {
          llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel, modelSelection: checked.modelSelection,
          prompt, history: state.history, context: snapshot.context, sessionId: state.modelSession, signal,
          attachments: uploaded.manifest, attachmentStore: ctx.get('attachments'),
        }
        const ensureBinding = async () => {
          signal.throwIfAborted()
          const current = await resolveProjectBinding(ctx.workspaceRegistry, workspaceId, workspaceRoot)
          if (current.sourcePath !== binding.sourcePath || current.ownerSessionId !== binding.ownerSessionId ||
              (await activeConversation(binding)).id !== conversation.id) throw Object.assign(new Error('Project changed'), {code:'canvas_changed'})
        }
        const record = (slot, receipt, additionId = undefined) => {
          const row = {...receipt, agentIndex:slot.index, round:slot.round, ...(additionId ? {additionId} : {})}
          if (toolCalls.length < 256) toolCalls.push(row)
          slot.toolCalls.push(row)
          if (slot.toolCalls.length > 64) slot.toolCalls.shift()
          delete slot.activeTool
        }
        const notePoint = (slot,point,targetId) => {
          slot.x = point.x
          slot.y = point.y
          slot.targetId = targetId
          const anchorId = typeof point.anchorId === 'string' ? point.anchorId : undefined
          const points = slot.points ??= []
          const last = points.at(-1)
          if (last?.x === point.x && last?.y === point.y && last?.targetId === targetId && last?.anchorId === anchorId) return
          points.push({seq:(last?.seq ?? 0)+1,x:point.x,y:point.y,targetId,...(anchorId ? {anchorId} : {})})
          if (points.length > 16) points.shift()
        }
        const pointAt = async (slot, targetId) => {
          if (typeof targetId !== 'string') return
          const point = await resolveAgentWorkTarget(editorHost, targetId, liveOptions).catch(() => null)
          if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) notePoint(slot,point,targetId)
        }
        const makeTools = (readOnly, slot, instruction, additionId = undefined, scopeRootId = undefined) => {
          const scopeRead = {}
          return {
            specs: [...canvasToolSpecs.filter(spec => !readOnly || spec.name === 'uic_canvas_read'),taskPlanSpec],
            protocol: { BlockAssembler, createUserMessage, createToolResultMessage }, receipts:[],
            onReceipt:receipt => record(slot,receipt,additionId),
            execute: async (name, args) => {
              await ensureBinding()
              slot.activeTool = {name}
              delete slot.targetIds
              if (name === taskPlanSpec.name) return updateTaskPlan(slot,args)
              const op = args.operations?.[0]
              const target = args.nodeId ?? op?.id ?? op?.parentId
              await pointAt(slot,target)
              const data = await runCanvasTool(editorHost, {
                ...options, sessionId: snapshot.sessionId, activePageId:snapshot.activePageId, visualSelection: additionId ? undefined : visualSelection, scopeRootId, scopeRead,
                allowDelete: canvasDeletionRequested(instruction),
                allowIconReplacement: canvasIconReplacementRequested(instruction),
              }, name, args)
              const found = data.changed?.[0]?.id ?? target ?? (args.query ? data.nodes?.[0]?.id : data.selection?.[0]?.id)
              if (found !== target) await pointAt(slot,found)
              const targets = Array.isArray(data.changed) ? data.changed.filter(row => row.op !== 'remove')
                : args.nodeId || args.query ? data.nodes ?? [] : data.selection ?? []
              slot.targetIds = targets.map(row => row.id).filter(id=>typeof id==='string').slice(0,12)
              return data
            },
          }
        }
        const place = async (slot, frame, operation, additionId = undefined) => {
          await ensureBinding()
          slot.status = 'writing'
          slot.activeTool = {name:'uic_canvas_place',target:frame.name}
          try {
            const receipt = await operation()
            slot.boardId = receipt.boardId ?? receipt.id
            if (Number.isFinite(receipt.x) && Number.isFinite(receipt.y)) {
              notePoint(slot,receipt,slot.boardId)
            } else await pointAt(slot,slot.boardId)
            if (Array.isArray(receipt.targetIds)) slot.targetIds = receipt.targetIds.filter(id=>typeof id==='string').slice(0,12)
            record(slot,{name:'uic_canvas_place',source:'editor',status:'success',target:receipt.name,summary:'写入画板，' + (receipt.count ?? receipt.nodeCount) + ' 个图层'},additionId)
            return receipt
          } catch (error) {
            record(slot,{name:'uic_canvas_place',source:'editor',status:'error',target:frame.name,summary:'写入画板未完成'},additionId)
            throw error
          }
        }
        const setModel = (slot, route) => {
          if (route?.provider && route.model) {
            slot.model = {provider:route.provider,model:route.model}
            slot.modelLabel = route.model
          }
        }
        const generateOne = async (input, slot, activeSnapshot, additionId = undefined) => {
          slot.status = 'running'
          const route = input.modelSelection ?? ctx.agentDefaultModel?.currentSelection()
          if (additionId) {
            const item = job.additions.find(a=>a.id===additionId)
            if (item && route?.provider && route.model) item.model = {provider:route.provider,model:route.model}
          } else {
            setModel(slot,route)
            slot.startedAt = performance.now()
            delete slot.finishedAt
          }
          const tools = makeTools(false,slot,input.prompt,additionId)
          const design = await generateCanvasDesign({...input,modelSelection:route,canvasTools:tools})
          if (!tools.receipts.some(c => c.name==='uic_canvas_edit' && c.status==='success')) await ensureBinding()
          let change
          if (design.frame) {
            state.previousFrame = await place(slot, design.frame, () => applyCanvasFrame(editorHost,design.frame,{
              ...options, previousFrame:state.previousFrame, snapshot:activeSnapshot, action:design.action ?? 'create', resolveAsset:uploaded.resolve,
            }),additionId)
            change = {name:state.previousFrame.name,count:state.previousFrame.nodeCount,revised:design.action==='revise'}
          }
          slot.status = 'done'
          if (!additionId) slot.finishedAt = performance.now()
          return {reply:design.reply,change}
        }
        let base = job.base
        if (!base && plan) {
          const canEditBoards = plan.mode === 'collaborate' && plan.iterations === 0 && plan.count > 1
          const noNewBoards =
            /(?:不要|禁止|别)(?:再)?(?:新增|新建|创建|复制)(?:(?:新的?|其他|任何)?(?:画板|画布|卡片)|[，。；,.\s]|$)/u.test(prompt) ||
            /\b(?:without|never|do not|don't)\s+(?:creat(?:e|ing)|duplicat(?:e|ing)|add(?:ing)?)\s+(?:(?:any|a|new|another|more|extra)\s+)*(?:artboards?|boards?|cards?)\b/iu.test(prompt)
          const editOnly = noNewBoards || (canEditBoards && /(?:原位|只改|\bin[- ]place\b)/iu.test(prompt))
          const editableBoards = canEditBoards && (editOnly || wantsParallelEdits(prompt)) ? snapshot.boards ?? [] : []
          if (editOnly && editableBoards.length < plan.count) {
            throw Object.assign(new Error('Insufficient distinct editable boards'), {code:'parallel_edit_targets'})
          }
          const models = await resolveParallelModels(ctx, plan, checked.modelSelection, signal)
          let imageRefs
          const store = common.attachmentStore
          job.slots.forEach((slot,i)=>setModel(slot,models[i]))
          const shared = {...common,context:{...common.context,editableBoards,editOnly},attachmentStore:store && {saveImages:items => imageRefs ??= store.saveImages(items)}}
          const batchKey = JSON.stringify([workspaceId,conversation.id,plan.requestId,job.signature])
          const designs = await generateParallelDesigns({plan, job, common:shared, models, signal,
            generate: async args => {
              if (args.planCount) return generateCanvasDesign(args)
              const assignment = args.context.parallelAssignment
              const slot = job.slots[assignment.agent-1]
              const rootId = assignment.board?.targetBoardId
              if (rootId) {
                if (!editableBoards.some(board=>board.id===rootId)) throw Object.assign(new Error('Invalid board assignment'),{code:'canvas_changed'})
                slot.boardId = rootId
                await pointAt(slot,rootId)
              }
              return generateCanvasDesign({...args,canvasTools:makeTools(!rootId,slot,prompt,undefined,rootId)})
            },
            commit: async (design,slot) => {
              const existing = job.assignment?.tasks[slot.index-1]?.targetBoardId
              const receipt = existing ? {index:slot.index,round:slot.round,boardId:existing,
                name:editableBoards.find(board=>board.id===existing)?.name ?? slot.title,revised:true} :
                await place(slot,design.frame,async () => (await applyParallelFrames(editorHost,[design],{
                ...liveOptions, resolveAsset:uploaded.resolve, batchKey, incremental:true, workAreas:job.workAreas,
              }))[0])
              job.placements ??= new Map()
              job.placements.set(slot.index + ':' + slot.round,receipt)
            },
          })
          const results = designs.map(design => job.placements.get(design.index + ':' + design.round))
          const briefLimit = Math.min(360, Math.floor(7600 / results.length) - 100)
          const reply = results.map(({name},i) => name.slice(0,96) + '\n' + designs[i].reply.slice(0,briefLimit)).join('\n\n')
          base = {reply,results}
          state.previousFrame = undefined
        } else if (!base) {
          const slot = job.slots[0]
          job.phase = 'generating'
          slot.title = prompt.trim().slice(0,100)
          slot.scope = '读取当前画布并执行设计要求'
          await pointAt(slot,visualSelection?.selectedIds?.[0])
          base = await generateOne(common,slot,snapshot)
          slot.completed = 1
        }
        job.base = base
        job.baseFinished = true
        const pendingHistory = job.pendingHistory ??= [{role:'user',text:prompt},{role:'assistant',text:base.reply.slice(0,8000)}]
        await drainCanvasInstructions(job,async addition => {
          await ensureBinding()
          const fresh = await readCanvasContext(editorHost,{
            ...options, sessionId:snapshot.sessionId, previousFrame:state.previousFrame,
            summarizeImported:summarizeImportedNode,
            describePage:(children, selectedIds) => describeImportedPage(children,selectedIds,addition.text),
          })
          if (fresh.activePageId !== snapshot.activePageId) throw Object.assign(new Error('Page changed'),{code:'canvas_changed'})
          const slot = job.slots[0]
          const input = {...common,prompt:addition.text,context:fresh.context,history:[...state.history,...pendingHistory].slice(-12)}
          const result = await generateOne(input,slot,fresh,addition.id)
          pendingHistory.push({role:'user',text:addition.text},{role:'assistant',text:result.reply.slice(0,8000)})
          return result.reply
        })
        if (job.additions.some(item => item.status === 'failed')) {
          throw Object.assign(new Error('A previous follow-up did not finish'), {code:'partial_followup'})
        }
        state.history = [...state.history,...pendingHistory].slice(-12)
        job.phase = 'done'
        job.finishedAt = performance.now()
        const progress = parallelProgress(job)
        const {reply,change,results} = base
        let historySaved = true
        try { await appendConversationTurn(binding,{prompt,reply,change,batchId:requestId,toolCalls,plan:progress,penAssetIds:uploaded.penAssetIds},conversation.id) }
        catch {
          historySaved = false
          ctx.logger.warn('Canvas Agent completed a turn but its conversation could not be saved')
        }
        const result = {reply,change:change ?? null,historySaved,plan:progress,...(toolCalls.length ? {toolCalls} : {}),...(results ? {results} : {})}
        if (toolRequestId) state.lastToolTurn = {id:toolRequestId,conversation:conversation.id,prompt,result}
        job.result = result
        return result
      } catch (error) {
        const confirmed = toolCalls.filter(c=>c.status==='success' && ['uic_canvas_edit','uic_canvas_place'].includes(c.name)).length
        const unsafeBaseRetry = job && !job.baseFinished && !plan && confirmed > 0
        if (job) {
          job.finishedAt = performance.now()
          job.phase = 'failed'
          job.accepting = false
          for (const slot of job.slots) {
            if (slot.status !== 'done') slot.status = job.baseFinished ? 'done' : 'failed'
            if (slot.startedAt && !slot.finishedAt) slot.finishedAt = job.finishedAt
            delete slot.activeTool
          }
          // Queued instructions have never run. Keep them for the same request's
          // next attempt unless resuming the base could repeat an earlier write.
          for (const item of job.additions) {
            if (item.status === 'running' || (unsafeBaseRetry && item.status === 'queued')) item.status = 'failed'
          }
        }
        const codes = ['invalid_request', 'invalid_pen', 'model_unavailable', 'model_timeout', 'model_failed', 'image_attachment_failed', 'invalid_design',
          'canvas_changed', 'canvas_unavailable', 'revision_conflict', 'edit_failed', 'parallel_edit_targets', 'partial_followup']
        const code = timeout.aborted ? 'model_timeout' : signal.aborted ? 'cancelled' : codes.includes(error?.code) ? error.code : 'edit_failed'
        const diagnostic = typeof error?.diagnostic === 'string' ? error.diagnostic : ''
        ctx.logger.warn('Canvas Agent request failed (%s %s)', code, diagnostic)
        if (toolCalls.length || job) {
          const failedReply = confirmed ? '已完成 ' + confirmed + ' 次画布写入，其余任务未完成。' : '本次画布请求未完成。'
          try { await appendConversationTurn(binding, {prompt, reply:failedReply, failed:true, ...((job?.baseFinished || unsafeBaseRetry) ? {batchId:requestId} : {}), toolCalls, plan:job && parallelProgress(job)}, conversation.id) }
          catch { ctx.logger.warn('Could not save canvas tool failure receipts') }
        }
        const failure = { error: unsafeBaseRetry ? 'partial_base' : code, diagnostic, ...(job ? {plan:parallelProgress(job)} : {}), ...(toolCalls.length ? {toolCalls} : {}) }
        if (job?.baseFinished && !job.additions.some(item => item.status === 'queued')) {
          state.history = [...state.history,...job.pendingHistory].slice(-12)
          job.result = failure
        } else if (unsafeBaseRetry) job.result = failure
        return failure
      } finally {
        state.running = false
      }
    }
  }
  ctx.plugin(CanvasAgent)
}
