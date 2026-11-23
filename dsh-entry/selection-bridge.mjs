import { createHash } from 'node:crypto'

// This function is also embedded verbatim in the managed editor's wasm-bindgen
// glue. Keep its dependencies local; the standalone editor and workers have no
// managed DSH parent.
export function createCompilerSelectionBridge(frame) {
  if (!frame || frame.parent === frame || new URL(frame.location.href).searchParams.get('embed') !== 'vscode') return null
  let requests = new WeakSet()
  const pending = new Set()
  let parentOrigin
  let current = null

  // OpenPencil already owns scene geometry, viewport transforms, label paint
  // and flight/reveal timing. Feed actual DSH tool targets into its existing
  // frame-local indicator poll. Neither the source document nor the daemon's
  // collaboration roster is modified.
  const indicators = new WeakSet()
  const palette = ['#3874df','#a650ba','#008579','#bd6423','#7056c2','#9a4866']
  let work = null, lastEpoch = 0, resetEpoch = 0, resetPending = false
  let viewport, candidate, lastClip, waiting
  const chinese = /^zh/i.test(new URL(frame.location.href).searchParams.get('locale') ?? frame.navigator?.language ?? 'en')
  const idOk = id => typeof id === 'string' && id.length > 0 && id.length <= 512
  const pageMatches = () => work && current && (current.activePageId || '0') === (work.pageId || '0')
  const now = () => Math.round(frame.performance?.now() ?? Date.now())

  function removeWaiting() {
    waiting?.remove()
    waiting = null
  }
  function clearWork() {
    if (work) {
      resetEpoch = work.epoch
      work = null
      resetPending = true
    }
    removeWaiting()
  }
  function showWaiting() {
    // A planning pen is a parked status, not a document coordinate. It can
    // appear before the first paint or selection sample; after a page change
    // never display another page's run. Actual layer pens remain native.
    if (!work || (current && !pageMatches()) || !frame.document?.body || work.finishAt) return removeWaiting()
    const slots = work.slots.filter(s => !s.ids.length && !['failed','done','cancelled'].includes(s.status))
    if (!slots.length) return removeWaiting()
    const caption = slot => {
      const name = 'Agent '+slot.index
      const phase = slot.status === 'queued' ? (chinese ? '规划中' : 'Planning') : (chinese ? '准备绘图' : 'Preparing')
      return name+' · '+phase
    }
    const signature = slots.map(caption).join('|')
    if (!waiting) {
      waiting = frame.document.createElement('div')
      waiting.setAttribute('role','group')
      waiting.setAttribute('aria-label',chinese ? '正在规划的画布 Agent' : 'Planning canvas agents')
      waiting.style.cssText = 'position:fixed;pointer-events:none;z-index:5;display:flex;align-items:center;justify-content:center;gap:12px 26px;flex-wrap:wrap;transform:translateY(-50%);font:600 11px/18px system-ui,sans-serif;'
      frame.document.body.appendChild(waiting)
    }
    // Use the actual canvas HTML surface when the renderer is idle or the
    // current geometry never produced the optional centre-band paint hint.
    const surface = frame.document.getElementById('op')?.getBoundingClientRect()
    const region = viewport ?? {x:surface?.left ?? 0,y:surface?.top ?? 0,
      w:surface?.width || frame.innerWidth,h:surface?.height || frame.innerHeight}
    Object.assign(waiting.style,{left:region.x+'px',width:region.w+'px',top:(region.y+Math.min(region.h*.22,100))+'px'})
    if (waiting.dataset.key === signature) return
    waiting.dataset.key = signature
    waiting.replaceChildren()
    for (const slot of slots) {
      const label = frame.document.createElement('span')
      label.style.cssText = 'display:inline-flex;align-items:flex-start;color:'+slot.color+';white-space:nowrap;'
      const pencil = frame.document.createElementNS('http://www.w3.org/2000/svg','svg')
      pencil.setAttribute('viewBox','0 0 24 24')
      pencil.setAttribute('width','20')
      pencil.setAttribute('height','20')
      pencil.setAttribute('aria-hidden','true')
      const nib = frame.document.createElementNS('http://www.w3.org/2000/svg','path')
      nib.setAttribute('d','M2 2 11 5 21 15 Q23 17 21 19 L19 21 Q17 23 15 21 L5 11 Z M5 11 11 5')
      nib.setAttribute('stroke','white')
      nib.setAttribute('stroke-width','1.7')
      nib.setAttribute('stroke-linejoin','round')
      nib.setAttribute('fill','currentColor')
      pencil.appendChild(nib)
      const text = frame.document.createElement('span')
      text.style.cssText = 'display:inline-block;max-width:145px;overflow:hidden;text-overflow:ellipsis;margin:15px 0 0 -3px;padding:0 7px;border-radius:6px;background:'+slot.color+';color:white;box-shadow:0 1px 4px #0002;'
      text.textContent = caption(slot)
      label.append(pencil,text)
      waiting.appendChild(label)
    }
  }
  function receiveWork(message) {
    if (!idOk(message.requestId) || !Array.isArray(message.slots) || message.slots.length > 6) return
    if (!message.slots.length) {
      if (work?.key !== message.requestId) return
      if (message.finished && work.slots.some(s => s.ids.length)) {
        // Give the next 400 ms native poll a chance to see a fast final write.
        work.finishAt ||= now() + 900
        removeWaiting()
      } else clearWork()
      return
    }
    if (work?.key !== message.requestId) {
      removeWaiting()
      lastEpoch = Math.max(lastEpoch+1,Date.now())
      work = {key:message.requestId,epoch:lastEpoch,pageId:message.pageId,slots:[],times:new Map(),visits:new Map(),lastSeen:now(),finishAt:0}
      resetPending = false
    }
    const stamp = now()
    work.lastSeen = stamp
    work.slots = message.slots.flatMap(s => {
      if (!Number.isInteger(s?.index) || s.index < 1 || s.index > 6) return []
      const name = ('Agent '+s.index+(s.title ? ' · '+String(s.title).slice(0,26) : ''))
      const points = Array.isArray(s.points) ? s.points.slice(-16) : []
      const visit = work.visits.get(s.index) ?? {seq:0,last:null,ids:[]}
      work.visits.set(s.index,visit)
      const fresh = points.filter(p => Number.isSafeInteger(p?.seq) && p.seq > visit.seq && idOk(p.targetId))
      // Existing components must remain visible, including during a read.
      // Past reveal timestamps let the native cursor point at them without
      // playing their construction animation or momentarily hiding a frame.
      let readBeat = stamp - 1100 - fresh.length*300
      for (const point of fresh) {
        const id = idOk(point.anchorId) ? point.anchorId : point.targetId
        readBeat += 300
        if (visit.last !== id) {
          // The native registry retains the first reveal time for each ID
          // within one epoch. Renew the mirror when a real tool revisits A
          // after B so the cursor returns to A instead of parking forever on B.
          if (work.times.has(id)) work.epoch = ++lastEpoch
          work.times.set(id,Math.max(1,readBeat))
          visit.last = id
        }
        visit.seq = point.seq
      }
      const anchored = new Map(points.filter(p => idOk(p?.targetId) && idOk(p.anchorId))
        .map(p => [p.targetId,p.anchorId]))
      const raw = [...points.map(p => p?.anchorId ?? p?.targetId),s.boardId,
        ...(Array.isArray(s.targetIds) ? s.targetIds.slice(-16) : []),s.targetId].filter(idOk)
      const targets = [...new Set(raw.map(id => anchored.get(id) ?? id))]
      for (const id of targets) if (!visit.ids.includes(id)) visit.ids.push(id)
      if (visit.ids.length > 24) { visit.ids = visit.ids.slice(-24); work.epoch = ++lastEpoch }
      const ids = visit.ids
      let beat = stamp
      for (const id of ids) {
        const isGenerated = s.boardId && id.startsWith(s.boardId)
        if (!work.times.has(id)) work.times.set(id,isGenerated ? beat : Math.max(1,stamp-1100))
        if (isGenerated) beat += 165
      }
      return [{index:s.index,name,color:palette[s.index-1],status:s.status,boardId:s.boardId,ids}]
    })
    // Bound history if a long turn scans or revisits many layers.
    if (work.times.size > 192) {
      const live = new Set(work.slots.flatMap(s => s.ids))
      for (const id of work.times.keys()) if (!live.has(id)) work.times.delete(id)
    }
    showWaiting()
  }
  const idlePayload = epoch => JSON.stringify({epoch,active:false,nodes:[],frames:[],previews:[],reveals:[]})
  function indicatorBody(xhr, original) {
    if (!indicators.has(xhr) || (!work && !resetPending)) return original
    const stamp = now()
    if (work && (stamp-work.lastSeen > 15000 || (work.finishAt && stamp >= work.finishAt))) clearWork()
    // The native relay can also serve OpenPencil's own independent designer.
    // Leave an actual daemon generation untouched when both features are used.
    try { if (JSON.parse(original).active) return original } catch { return original }
    if (resetPending) { resetPending = false; return idlePayload(resetEpoch) }
    if (!work) return original
    if (!pageMatches()) { showWaiting(); return idlePayload(work.epoch) }
    showWaiting()
    const nodes = [], frames = [], reveals = []
    for (const slot of work.slots) {
      if (slot.status === 'failed' || slot.status === 'cancelled') continue
      for (const id of slot.ids) {
        const tag = {id,color:slot.color,name:slot.name}
        nodes.push(tag)
        if (id === slot.boardId) frames.push(tag)
        reveals.push({id,ms:work.times.get(id)})
      }
    }
    return JSON.stringify({epoch:work.epoch,active:true,nodes,frames,previews:[],reveals,
      cursorAgent:work.slots.length===1 && nodes.length ? {color:work.slots[0].color,name:work.slots[0].name} : null})
  }

  function clearDocument() {
    clearWork()
    requests = new WeakSet()
    current = null
    for (const timer of pending) frame.clearTimeout(timer)
    pending.clear()
  }

  frame.addEventListener('message', event => {
    if (event.source !== frame.parent || !event.origin || event.origin === 'null') return
    if (parentOrigin && parentOrigin !== event.origin) return
    const message = event.data
    // The official shell uses JSON strings. Check only its message type. In
    // particular, never retain the init capability or parse a document body.
    if (typeof message === 'string') {
      if (!parentOrigin && message.startsWith('{"type":"op-bridge/init",')) parentOrigin = event.origin
      if (parentOrigin && message.startsWith('{"type":"op-bridge/open-document",')) clearDocument()
      return
    }
    if (parentOrigin && message?.type === 'uic/agent-work') { receiveWork(message); return }
    if (!parentOrigin || message?.type !== 'uic/selection-request' ||
        typeof message.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(message.requestId) ||
        pending.size >= 16) return
    // The shell samples the actual UI selection every 400ms, including an
    // explicit empty selection. Allow a tick after the question so a click or
    // page change immediately before Send is reflected in the answer.
    const timer = frame.setTimeout(() => {
      pending.delete(timer)
      frame.parent.postMessage({ type: 'uic/selection-result', requestId: message.requestId,
        activePageId: current?.activePageId ?? null, selectedIds: current?.selectedIds ?? null }, parentOrigin)
    }, 475)
    pending.add(timer)
  })
  frame.addEventListener('pagehide', clearDocument)

  return {
    opened(xhr, method, url) {
      requests.delete(xhr)
      indicators.delete(xhr)
      if (!parentOrigin) return
      try {
        const target = new URL(url, frame.location.href)
        if (target.origin !== frame.location.origin) return
        if (method === 'GET' && target.pathname === '/api/mcp/indicators') indicators.add(xhr)
        if (method === 'POST' && target.pathname === '/api/mcp/selection') requests.add(xhr)
      } catch { /* Not an editor selection URL. */ }
    },
    indicatorBody,
    clipped(x,y,w,h) { lastClip = {x,y,w,h} },
    filled(x,y,w,h) {
      // At this pinned revision CanvasViewport::paint starts by clipping and
      // filling its same rectangle. Chrome regions have smaller/narrow bounds.
      if (lastClip?.x !== x || lastClip.y !== y || lastClip.w !== w || lastClip.h !== h) return
      if (y <= 0 || y > 100 || h < frame.innerHeight * .55 || w < frame.innerWidth * .23) return
      if (!candidate || w*h > candidate.w*candidate.h) candidate = {x,y,w,h}
    },
    endFrame() {
      const next = candidate
      candidate = null
      if (!next || viewport && next.x===viewport.x && next.y===viewport.y && next.w===viewport.w && next.h===viewport.h) return
      viewport = next
      showWaiting()
    },
    tracks(xhr) { return requests.has(xhr) },
    sent(xhr, body) {
      if (!requests.delete(xhr)) return
      current = null
      if (typeof body !== 'string' || body.length > 128 * 1024) return
      try {
        const { selectedIds, activePageId } = JSON.parse(body)
        if (!Array.isArray(selectedIds) || selectedIds.length > 256 ||
            !selectedIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512) ||
            !(activePageId == null || typeof activePageId === 'string' && activePageId.length <= 512)) return
        current = { selectedIds, activePageId: activePageId ?? null }
        if (work) showWaiting()
      } catch { /* An invalid sample must not leave an older one selected. */ }
    },
  }
}

const openCall = 'getObject(arg0).open(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4), arg5 !== 0);'
const sendCall = 'getObject(arg0).send(arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2));'
const officialGlueHash = 'da912b7164b26002b1127a30a06b3029fbfd9aa671efdc932208f25797635a95'

export function patchCompilerSelectionGlue(source) {
  if (createHash('sha256').update(source).digest('hex') !== officialGlueHash ||
      source.split(openCall).length !== 2 || source.split(sendCall).length !== 2) {
    throw new Error('Unexpected managed OpenPencil web glue version')
  }
  const init = 'const uicSelectionBridge = (' + createCompilerSelectionBridge.toString() + ")(typeof window === 'undefined' ? null : window);\n"
  const response = 'const ret = getObject(arg1).responseText;'
  const clip = 'getObject(arg0).clipRect(arg1, arg2, arg3, arg4);'
  const fill = 'getObject(arg0).fillRect(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);'
  const end = 'getObject(arg0).endFrame();'
  if ([response,clip,fill,end].some(anchor => source.split(anchor).length !== 2)) throw new Error('Unexpected managed OpenPencil rendering glue')
  return init + source.replace(response, 'const xhr = getObject(arg1), original = xhr.responseText; const ret = uicSelectionBridge?.indicatorBody(xhr, original) ?? original;')
    .replace(clip, clip + ' uicSelectionBridge?.clipped(arg1,arg2,arg3,arg4);')
    .replace(fill, fill + ' uicSelectionBridge?.filled(arg1,arg2,arg3,arg4);')
    .replace(end, end + ' uicSelectionBridge?.endFrame();')
    .replace(openCall, [
    'const xhr = getObject(arg0), method = getStringFromWasm0(arg1, arg2), url = getStringFromWasm0(arg3, arg4);',
    '            xhr.open(method, url, arg5 !== 0);',
    '            uicSelectionBridge?.opened(xhr, method, url);',
  ].join('\n')).replace(sendCall, [
    'const xhr = getObject(arg0), body = arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2);',
    '            xhr.send(body);',
    '            if (uicSelectionBridge?.tracks(xhr)) uicSelectionBridge.sent(xhr, body);',
  ].join('\n'))
}
