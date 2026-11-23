import { createHash, randomUUID } from 'node:crypto'

const designDirections = {
  layout: ['clear single-column flow', 'split navigation and focused detail', 'compact grouped grid',
    'progressive disclosure', 'priority stack with contrasting scale', 'balanced asymmetric composition'],
  style: ['quiet editorial typography', 'warm materials and soft contrast', 'precise utility styling',
    'strong typographic hierarchy', 'restrained monochrome with one accent', 'friendly rounded geometry'],
  creative: ['familiar direct interaction', 'an alternate organizing idea', 'a contextual workflow',
    'an unexpected but usable visual metaphor', 'content-led discovery', 'a simplified interaction model'],
}

const invalid = message => Object.assign(new Error(message), { code: 'invalid_design', diagnostic: message })

export function newParallelJob(plan, signature, canvas, conversationId) {
  return {
    signature, canvas, conversationId, startedAt:performance.now(), phase: 'queued', slots: Array.from({length: plan.count}, (_, i) => ({
      index: i + 1, round: 0, title: 'Agent ' + (i + 1), scope:'', status: 'queued', sessionId: randomUUID(), designs: [], toolCalls: [],
    })), total: plan.count * (1 + plan.iterations), additions: [], accepting: true,
  }
}

export function parallelProgress(job) {
  return {
    phase: job.phase, total: job.total, elapsedMs:Math.max(0,Math.round((job.finishedAt ?? performance.now()) - job.startedAt)),
    completed: job.slots.reduce((n, slot) => n + (slot.completed ?? slot.designs.length), 0),
    sessionId: job.canvas.sessionId, pageId: job.canvas.activePageId,
    slots: job.slots.map(({sessionId, designs, pendingDesign, completed, startedAt, finishedAt, ...display}) => ({
      ...display, toolCalls: display.toolCalls.slice(-64),
      ...(Number.isFinite(startedAt) ? {elapsedMs:Math.max(0,Math.round((finishedAt ?? performance.now())-startedAt))} : {}),
    })),
    additions: job.additions.map(({id,text,status,reply,startedAt,finishedAt,model}) => ({id,text,status,...(reply ? {reply}: {}),
      ...(model ? {model} : {}), ...(Number.isFinite(startedAt) ? {elapsedMs:Math.max(0,Math.round((finishedAt ?? performance.now())-startedAt))} : {})})),
    steps: [
      {title:'读取当前画布',status:'done'},
      {title:job.slots.length > 1 ? '分配并执行画板任务' : '执行设计任务',status:job.baseFinished ? 'done' : job.phase === 'failed' ? 'failed' : 'running'},
      ...(job.additions.length ? [{title:'处理追加要求',status:job.additions.some(a=>a.status==='failed') ? 'failed' :
        job.additions.every(a=>a.status==='done') ? 'done' : job.phase==='followup' ? 'running' : 'queued'}] : []),
      {title:'记录结果',status:job.phase==='done' ? 'done' : job.phase==='failed' ? 'failed' : job.phase==='recording' ? 'running' : 'queued'},
    ],
  }
}

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
export function queueCanvasInstruction(job, id, text) {
  if (!uuid(id) || typeof text !== 'string' || !text.trim() || text.length > 2000) return {error:'invalid_request'}
  text = text.trim()
  const existing = job.additions.find(item => item.id === id)
  if (existing) return existing.text === text ? {ok:true,status:existing.status} : {error:'invalid_request'}
  if (!job.accepting) return {error:'closed'}
  if (job.additions.length >= 8) return {error:'busy'}
  job.additions.push({id,text,status:'queued'})
  return {ok:true,status:'queued'}
}

// Appending and closing the queue happen in the same JS event loop. An
// acknowledgement can never race past the final empty-queue check.
export async function drainCanvasInstructions(job, execute) {
  for (const item of job.additions) {
    if (item.status !== 'queued') continue
    job.phase = 'followup'
    item.status = 'running'
    item.startedAt = performance.now()
    try {
      item.reply = (await execute(item)).slice(0,2000)
      item.status = 'done'
    } catch (error) {
      item.status = 'failed'
      throw error
    } finally { item.finishedAt = performance.now() }
  }
  job.accepting = false
}

// Keep each workspace's resumable generations bounded; board IDs remain
// deterministic even after an in-memory job has expired or DSH has restarted.
export function openParallelJob(jobs, plan, request, snapshot, conversationId) {
  const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  let job = jobs.get(plan.requestId)
  if (job && (job.signature !== signature || job.conversationId !== conversationId ||
      job.canvas.activePageId !== snapshot.activePageId || job.canvas.sessionId !== snapshot.sessionId)) {
    throw Object.assign(new Error('Canvas or request changed'), {code: 'canvas_changed'})
  }
  if (!job) {
    job = newParallelJob(plan, signature, {sessionId: snapshot.sessionId, activePageId: snapshot.activePageId}, conversationId)
    if (jobs.size >= 4) jobs.delete(jobs.keys().next().value)
    jobs.set(plan.requestId, job)
  }
  return job
}

// Only explicit requests to change existing artwork may assign editable board
// roots. The planner can select IDs from this invocation's current page only.
export function wantsParallelEdits(prompt) {
  return /(?:修改|编辑|调整|原位|更新指定|改成|改为|换成|替换|重命名|更改|补充|增加到|添加到|移除|去掉|\b(?:edit|change|rename|replace|update|modify|remove|revise|adjust)\b)/iu.test(prompt)
}
export function parseAssignments(value, count, editableBoards = [], editOnly = false) {
  const bounded = (text, limit) => typeof text === 'string' && text.trim().length > 0 && text.length <= limit
  if (!bounded(value?.shared, 1600) || !Array.isArray(value.tasks) || value.tasks.length !== count ||
      !value.tasks.every(task => bounded(task?.name, 100) && bounded(task?.scope, 620)) ||
      new Set(value.tasks.map(task => task.name.trim().toLowerCase())).size !== count ||
      new Set(value.tasks.map(task => task.scope.trim().toLowerCase())).size !== count) {
    throw invalid('Return one shared design brief and one distinct board name and scope per worker.')
  }
  const allowed = new Set(editableBoards.map(b=>b.id))
  const targets = value.tasks.map(t=>t.targetBoardId).filter(id=>id != null)
  if (editOnly && targets.length !== count) throw invalid('Every task must target a separate existing artboard. Supply targetBoardId for each task.')
  if (targets.some(id=>!allowed.has(id)) || new Set(targets).size !== targets.length) {
    throw invalid('Choose each editable board at most once and use its exact ID from editableBoards.')
  }
  return {shared:value.shared.trim(),tasks:value.tasks.map(t=>({name:t.name.trim(),scope:t.scope.trim(),
    ...(t.targetBoardId ? {targetBoardId:t.targetBoardId} : {})}))}

}

export async function generateParallelDesigns({plan, job, generate, models, common, signal, commit}) {
  const collaboration = plan.mode === 'collaborate' && plan.count > 1
  if (collaboration && !job.assignment) {
    job.phase = 'planning'
    job.assignment = await generate({
      ...common, sessionId: randomUUID(), signal,
      planCount: plan.count,
    })
  }
  job.phase = 'generating'
  const directions = designDirections[plan.focus]
  for (let round = 0; round <= plan.iterations; round++) {
    signal.throwIfAborted()
    const settled = await Promise.allSettled(job.slots.map(async slot => {
      if (slot.designs[round]) return
      slot.round = round
      slot.status = 'running'
      slot.startedAt = performance.now()
      delete slot.finishedAt
      const assigned = job.assignment?.tasks[slot.index - 1]
      slot.title = assigned?.name ?? '方案 ' + slot.index
      slot.scope = assigned?.scope ?? common.prompt?.trim().slice(0, 220) ?? ''
      try {
        const previous = slot.designs[round - 1]
        const direction = directions[(round + (collaboration ? 0 : slot.index - 1)) % directions.length]
        const assignment = {
          mode: plan.mode, agent: slot.index, agents: plan.count, round, focus: plan.focus, direction,
          ...(collaboration ? {shared: job.assignment.shared, board: job.assignment.tasks[slot.index - 1],
            siblingBoards: job.assignment.tasks.filter((_, i) => i !== slot.index - 1).map(t => t.name)} : {}),
          ...(previous ? {previousVersion: previous.frame} : {}),
        }
        const design = slot.pendingDesign ?? await generate({
          ...common, modelSelection: models[slot.index - 1], sessionId: slot.sessionId, signal,
          context: {...common.context, canRevise: false, parallelAssignment: assignment},
          requireFrame: !assigned?.targetBoardId,
        })
        if (assigned?.targetBoardId) {
          if (design?.frame || !design?.toolCalls?.some(r=>r.name==='uic_canvas_edit' && r.status==='success')) {
            throw invalid('The assigned existing board must be edited in place and confirmed by an edit tool.')
          }
        } else if (!design?.frame || design.action === 'revise') throw invalid('Each canvas agent must return its own editable artboard.')
        if (commit) {
          slot.pendingDesign = design
          slot.status = 'writing'
          await commit({index:slot.index,round,...design},slot)
          delete slot.pendingDesign
        }
        slot.designs.push(design)
        slot.status = 'done'
      } catch (error) {
        slot.status = 'failed'
        throw error
      } finally { slot.finishedAt = performance.now() }
    }))
    const failed = settled.findIndex(result => result.status === 'rejected')
    if (failed >= 0) {
      job.phase = 'failed'
      const cause = settled[failed].reason
      const detail = 'Agent ' + (failed + 1) + ' · ' + (round ? 'V' + (round + 1) : 'V1')
      throw Object.assign(new Error(detail), {code: cause?.code ?? 'model_failed',
        diagnostic: [detail, cause?.diagnostic].filter(Boolean).join(' · ').slice(0,340)})
    }
  }
  const designs = []
  for (let round = 0; round <= plan.iterations; round++) {
    for (const slot of job.slots) designs.push({index:slot.index, round, ...slot.designs[round]})
  }
  return designs
}
