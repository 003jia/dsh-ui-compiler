// Embedded into the OpenPencil client at build time. The existing snapshot and
// save operation still owns the atomic write, source hash and successor grant.
export function createCompilerAutosave(read, save, timers = globalThis, now = Date.now) {
  let latest
  let persisted
  let timer
  let firstChange
  let closed = false
  let conflicts = 0

  const newer = (a, b) => a && (!b || a.generation > b.generation ||
    (a.generation === b.generation && a.revision > b.revision))

  function cancel() {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
    firstChange = undefined
  }

  function schedule() {
    const state = read()
    if (closed || state.recovery || state.phase !== 'ready') return
    firstChange ??= now()
    if (timer !== undefined) timers.clearTimeout(timer)
    // Save after the gesture settles, but also checkpoint a long editing run.
    const delay = Math.max(0, Math.min(900, firstChange + 5000 - now()))
    timer = timers.setTimeout(() => {
      cancel()
      const state = read()
      if (!closed && state.dirty && !state.recovery && state.phase === 'ready') void save()
    }, delay)
  }

  async function flush() {
    cancel()
    while (!closed) {
      const state = read()
      if (state.pending) {
        if (!await state.pending) return false
        continue
      }
      if (!state.dirty) return state.phase !== 'error'
      if (state.recovery || state.phase !== 'ready') return false
      if (!await save()) return false
    }
    return false
  }

  return {
    changed(message) {
      if (closed || newer(latest, message)) return undefined
      // An already-processed notification can still be in the frame's queue.
      if (message.dirty && persisted && !newer(message, persisted)) return undefined
      latest = {generation: message.generation, revision: message.revision, dirty: message.dirty}
      if (message.dirty) schedule()
      else cancel()
      return message.dirty
    },
    get conflicts() { return conflicts },
    conflict() { conflicts++; cancel() },
    committed(snapshot) {
      persisted = {generation: snapshot.generation, revision: snapshot.revision}
      cancel()
      return Boolean(latest?.dirty && newer(latest, persisted))
    },
    ready() { if (read().dirty) schedule() },
    flush,
    dispose() { closed = true; cancel() },
  }
}

// Keep normal editor cards and pipeline drafts on the unmodified manual path.
// Each replacement is checked by the builder against the pinned upstream bundle.
export function patchCompilerAutosave(source, replaceOnce) {
  const edit = (anchor, replacement) => { source = replaceOnce(source, anchor, replacement) }
  const refs = 'const saveInFlightRef = (0, react.useRef)();'
  edit(refs, refs + '\n\tconst autosaveRef = (0, react.useRef)();')
  const begin = 'const operation = (async () => {\n\t\t\tupdatePhase("saving");'
  edit(begin, 'const autosave = autosaveRef.current;\n\t\tconst conflictAtStart = autosave?.conflicts;\n\t\t' + begin)
  const submit = 'const saveResponse = await responseJson(await fetch(launch.saveUrl, {'
  edit(submit, 'if (autosave && (autosaveRef.current !== autosave || conflictAtStart !== autosave.conflicts)) return false;\n\t\t\t\t' + submit)
  const remember = 'rememberEditorSuccessor(editorGrant.launchUrl, saveResponse);'
  edit(remember, remember + '\n\t\t\t\tif (autosave && (autosaveRef.current !== autosave || conflictAtStart !== autosave.conflicts)) return false;')
  const commit = 'restoredRecoveryRef.current = false;\n\t\t\t\tupdateDirty(false);\n\t\t\t\tupdatePhase("ready");'
  edit(commit, commit.replace('updateDirty(false)', 'updateDirty(autosave?.committed(snapshot) ?? false)') +
    '\n\t\t\t\tautosave?.ready();')
  const failure = 'return true;\n\t\t\t} catch (error) {\n\t\t\t\tsetFailure(error instanceof Error ? error.message : String(error));\n\t\t\t\tupdatePhase("error");\n\t\t\t\treturn false;\n\t\t\t} finally'
  edit(failure, failure.replace('setFailure(', 'if (autosave && (autosaveRef.current !== autosave || conflictAtStart !== autosave.conflicts)) return false;\n\t\t\t\tsetFailure('))
  const lifecycle = '(0, react.useEffect)(() => {\n\t\tpublishLifecycle();'
  edit(lifecycle, `const projectCanvas = Boolean(workbenchTitle);
  (0, react.useEffect)(() => {
    if (!projectCanvas) return;
    const autosave = createCompilerAutosave(() => ({
      phase: phaseRef.current, dirty: dirtyRef.current, recovery: restoredRecoveryRef.current,
      pending: saveInFlightRef.current,
    }), save);
    autosaveRef.current = autosave;
    return () => { autosave.dispose(); autosaveRef.current = undefined; };
  }, [projectCanvas, save, sessionId]);
  ` + lifecycle)
  const controller = 'lifecycleControllerRef.current?.({\n'
  edit(controller, controller + '      flushCompilerAutosave: () => autosaveRef.current?.flush() ?? Promise.resolve(false),\n')
  const dirty = 'if (managedEditorAllowsSave(launchRef.current)) updateDirty(restoredRecoveryRef.current || message.dirty);'
  edit(dirty, `if (managedEditorAllowsSave(launchRef.current)) {
            const next = autosaveRef.current ? autosaveRef.current.changed(message) : message.dirty;
            if (next !== undefined) updateDirty(restoredRecoveryRef.current || next);
          }`)
  const opened = 'if (restoredRecoveryRef.current) updateDirty(true);'
  edit(opened, opened + '\n\t\t\t\t\tautosaveRef.current?.ready();')
  const syncConflict = 'setFailure(editorPanelCopy(localeRef.current).syncConflict(message.serverVersion));'
  edit(syncConflict, 'autosaveRef.current?.conflict();\n\t\t\t\t\t' + syncConflict)
  const component = 'function ManagedOpenPencilEditor({'
  edit(component, createCompilerAutosave.toString() + '\n' + component)
  return source
}
