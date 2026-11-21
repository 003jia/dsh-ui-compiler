// Accept only routes currently advertised by DSH. List discovery belongs to the
// adapter and has no signal parameter, so a blocked adapter must not hold the
// canvas request open after cancellation.
async function advertisedModels(llm, provider, signal) {
  signal.throwIfAborted()
  let stop
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([llm.listModels(provider), cancelled]) }
  finally { signal.removeEventListener('abort', stop) }
}

/** Validate a canvas override without mutating a DSH session or its global default. */
export async function resolveCanvasSelection({ llm, agentDefaultModel }, override, signal) {
  signal.throwIfAborted()
  if (override.provider === undefined && override.reasoningEffort === undefined) return {}
  const route = override.provider === undefined ? agentDefaultModel.currentSelection() : override
  const provider = route?.provider
  const model = route?.model
  try {
    if (!provider || !model || !llm.listProviders().some(entry => entry.id === provider)) {
      return { error: 'model_unavailable' }
    }
    const models = await advertisedModels(llm, provider, signal)
    if (!models.some(entry => entry.id === model)) return { error: 'model_unavailable' }
    const effort = override.reasoningEffort
    if (effort === undefined) return { modelSelection: { provider, model } }
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (!info.reasoning?.efforts.some(entry => entry.id === effort)) return { error: 'unsupported_effort' }
    return { modelSelection: { provider, model, reasoningEffort: effort } }
  } catch {
    signal.throwIfAborted()
    return { error: 'model_unavailable' }
  }
}
