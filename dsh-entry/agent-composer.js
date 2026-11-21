/** Mounted alongside the managed editor so panel switches keep the conversation alive. */
const canvasAgentText = {
  zh: {
    title: "画布 Agent",
    placeholder: "告诉 Agent，你想设计什么…",
    send: "发送给画布 Agent",
    open: "展开对话记录",
    close: "收起对话记录",
    minimize: "最小化聊天框",
    restore: "展开聊天框",
    pending: "Agent 正在分析需求…",
    failed: "处理失败，请重试。",
    emptyReply: "Agent 没有返回回复，请重试。",
    you: "你",
    model: "模型", effort: "思考深度", followModel: "跟随 DSH", defaultEffort: "默认",
    unsupported: "不支持", unavailable: "已不可用", loadingModels: "正在加载…",
    noModels: "暂无可用模型", loadFailed: "加载失败", reload: "刷新模型列表", refresh: "刷新",
  },
  en: {
    title: "Canvas Agent",
    placeholder: "Tell the agent what you want to design…",
    send: "Send to canvas agent",
    open: "Show conversation history",
    close: "Hide conversation history",
    minimize: "Minimize chat",
    restore: "Expand chat",
    pending: "The agent is analyzing your request…",
    failed: "The request failed. Try again.",
    emptyReply: "The agent returned an empty reply. Try again.",
    you: "You",
    model: "Model", effort: "Reasoning effort", followModel: "DSH default", defaultEffort: "Default",
    unsupported: "Not supported", unavailable: "Unavailable", loadingModels: "Loading…",
    noModels: "No models available", loadFailed: "Load failed", reload: "Reload models", refresh: "Retry",
  },
};

const canvasAgentCss = `
  .uic-canvas-agent {
    position: absolute; z-index: 2; left: 50%; bottom: 52px; transform: translateX(-50%);
    width: min(480px, max(270px, calc(100% - 526px)), calc(100% - 24px));
    display: grid; grid-template-columns: minmax(0, 1fr);
    font: 13px/20px system-ui, sans-serif; color: var(--dsw-alias-label-primary, CanvasText);
    pointer-events: none;
  }
  .uic-agent-expanded, .uic-canvas-agent .uic-agent-dock {
    grid-area: 1 / 1; align-self: end; transform-origin: bottom center;
    transition: opacity 140ms ease, transform 180ms cubic-bezier(.2,.8,.2,1), visibility 0s;
  }
  .uic-agent-expanded { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .uic-agent-expanded[inert], .uic-canvas-agent .uic-agent-dock[inert] {
    visibility: hidden; opacity: 0; transform: translateY(7px) scale(.96);
    transition-delay: 0s, 0s, 180ms;
  }
  .uic-canvas-agent .uic-agent-pill, .uic-canvas-agent .uic-agent-panel, .uic-canvas-agent .uic-agent-dock {
    box-sizing: border-box; pointer-events: auto;
    background: var(--dsw-alias-button-floating-fill, Canvas);
    border: 1px solid var(--dsw-alias-border-l2, GrayText);
    box-shadow: 0 3px 14px rgb(0 0 0 / 11%);
  }
  .uic-canvas-agent .uic-agent-dock {
    justify-self: center; display: inline-flex; align-items: center; gap: 6px;
    height: 36px; padding: 0 14px; border-radius: 999px; font: inherit; color: inherit;
  }
  .uic-canvas-agent .uic-agent-dock:hover { background: var(--dsw-alias-bg-module-platform, ButtonFace); }
  .uic-canvas-agent .uic-agent-dock[inert], .uic-agent-expanded[inert] > * { pointer-events: none; }
  .uic-canvas-agent .uic-agent-pill {
    display: flex; flex-direction: column; gap: 2px; margin: 0;
    padding: 6px 8px; border-radius: 22px; container: uic-composer / inline-size;
  }
  .uic-agent-prompt, .uic-agent-footer {
    display: flex; align-items: center; gap: 6px; min-width: 0;
  }
  .uic-agent-footer { justify-content: space-between; }
  .uic-canvas-agent .uic-agent-pill:focus-within {
    border-color: var(--dsw-focus-ring-color, Highlight);
  }
  .uic-canvas-agent .uic-agent-input {
    flex: 1; min-width: 0; width: 0; min-height: 20px; max-height: 80px; padding: 0;
    border: 0; border-radius: 0; background: transparent; color: inherit;
    font: inherit; line-height: 20px; outline: none; resize: none;
  }
  .uic-canvas-agent .uic-agent-input::placeholder {
    color: var(--dsw-alias-label-secondary, GrayText); opacity: 1;
  }
  .uic-canvas-agent .uic-agent-models {
    display: flex; flex: 1 1 auto; align-items: center; gap: 4px; min-width: 0; font-size: 12px;
  }
  .uic-agent-models label {
    display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 64%;
    padding: 3px 5px; line-height: 18px; border-radius: 8px;
  }
  .uic-agent-models label:hover, .uic-agent-models label:focus-within {
    background: var(--dsw-alias-bg-module-platform, ButtonFace);
  }
  .uic-agent-models label > span { flex: none; color: var(--dsw-alias-label-secondary, GrayText); }
  .uic-agent-models select {
    field-sizing: content; min-width: 0; max-width: 100%; padding: 0; margin: 0; font: inherit;
    text-overflow: ellipsis; color: inherit; background: transparent; cursor: pointer; border: 0;
  }
  .uic-agent-models select:disabled { cursor: default; }
  .uic-agent-models label:focus-within {
    outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, Highlight);
  }
  .uic-agent-models select:focus { outline: none; }
  @container uic-composer (max-width: 350px) {
    .uic-agent-models label > span { display: none; }
  }
  .uic-agent-models .uic-agent-reload { flex: none; min-height: 24px; }
  .uic-canvas-agent .uic-agent-circle {
    display: inline-flex; align-items: center; justify-content: center; flex: 0 0 34px;
    width: 34px; height: 34px; padding: 0; border-radius: 50%;
  }
  .uic-canvas-agent .uic-agent-mark {
    color: var(--dsw-alias-brand-text, var(--dsw-alias-label-primary, CanvasText));
  }
  .uic-canvas-agent .uic-agent-minimize {
    flex: none; width: 28px; height: 28px; padding: 0; border-radius: 50%;
    color: var(--dsw-alias-label-secondary, GrayText);
  }
  .uic-agent-panel > .uic-agent-minimize {
    align-self: center; width: 44px; height: 24px; border-radius: 999px;
    background: var(--dsw-alias-bg-module-platform, ButtonFace);
  }
  .uic-agent-panel > .uic-agent-minimize:hover {
    color: var(--dsw-alias-label-primary, CanvasText);
  }
  .uic-canvas-agent .uic-agent-wait {
    width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: uic-agent-turn 1s linear infinite;
  }
  @keyframes uic-agent-turn { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .uic-canvas-agent .uic-agent-expanded, .uic-canvas-agent .uic-agent-dock { transition: none; }
    .uic-canvas-agent .uic-agent-wait { animation: none; }
  }
  .uic-canvas-agent .uic-agent-panel {
    display: flex; flex-direction: column; padding-top: 6px; border-radius: 18px;
    max-height: min(30vh, 248px); min-height: 0; overflow: hidden;
  }
  .uic-agent-panel > .uic-agent-transcript {
    min-height: 0; padding: 4px 14px 12px; overflow: auto;
    overscroll-behavior: contain; scrollbar-width: thin;
  }
  .uic-canvas-agent .uic-agent-message {
    display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  }
  .uic-canvas-agent .uic-agent-message[data-role="user"] { align-items: flex-end; }
  .uic-canvas-agent .uic-agent-message + .uic-agent-message { margin-top: 10px; }
  .uic-canvas-agent .uic-agent-author {
    padding-inline: 4px; font-size: 11px; line-height: 16px; font-weight: 500;
    color: var(--dsw-alias-label-secondary, GrayText);
  }
  .uic-canvas-agent .uic-agent-bubble {
    box-sizing: border-box; max-width: 90%; padding: 8px 12px;
    white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 14px 14px 14px 4px;
    color: var(--dsw-alias-label-primary, CanvasText);
    background: var(--dsw-alias-bg-module-platform, ButtonFace);
  }
  .uic-canvas-agent [data-role="user"] .uic-agent-bubble {
    border-radius: 14px 14px 4px 14px;
    background: var(--dsw-specific-bubble-highlight, Highlight);
    color: var(--dsw-alias-label-primary, HighlightText);
  }
  .uic-canvas-agent .uic-agent-bubble[role="alert"] {
    border-inline-start: 3px solid var(--dsw-alias-state-error-primary, CanvasText);
  }
`;

function readCanvasModelChoice(workspaceId) {
  try {
    const value = JSON.parse(localStorage.getItem("uic-canvas-model:" + workspaceId) || "{}");
    const selected = {};
    if (typeof value?.provider === "string" && value.provider && typeof value.model === "string" && value.model) {
      selected.provider = value.provider;
      selected.model = value.model;
    }
    if (typeof value?.reasoningEffort === "string" && value.reasoningEffort) selected.reasoningEffort = value.reasoningEffort;
    return selected;
  } catch { return {}; }
}

function CanvasAgentComposer({ locale, disabled, onGenerate, initialTurns = [], formatReply, project,
  workspaceId, active, loadModels, catalogVersion }) {
  const { jsx, jsxs } = react_jsx_runtime;
  const { useEffect, useId, useLayoutEffect, useRef, useState } = react;
  const { Button, IconSparkleRegular, IconSendOutlineMedium, IconChevronDownOutlineMedium, observeComposition } =
    require("@deepseek-ai/dsh-client-ui-primitives");
  const labels = locale?.startsWith("zh") ? canvasAgentText.zh : canvasAgentText.en;
  const transcriptId = useId();
  const composerId = useId();
  const input = useRef(null);
  const dock = useRef(null);
  const moveFocus = useRef(false);
  const transcript = useRef(null);
  const composing = useRef(null);
  const inFlight = useRef(null);
  const [draft, setDraft] = useState(() => project.draft);
  const [history, setHistory] = useState(() => initialTurns.flatMap(turn => [
    { role: "user", content: turn.prompt },
    { role: "assistant", content: formatReply(turn) },
  ]));
  const [expanded, setExpanded] = useState(initialTurns.length > 0);
  const [minimized, setMinimized] = useState(() => Boolean(project.chatMinimized));
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [choice, setChoice] = useState(() => project.modelChoice || readCanvasModelChoice(workspaceId));
  const [catalog, setCatalog] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);

  function resizeChat(compact) {
    moveFocus.current = true;
    project.chatMinimized = compact;
    setMinimized(compact);
  }

  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (minimized ? dock : input).current?.focus({ preventScroll: true });
  }, [minimized]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setCatalog(null);
    setLoadFailed(false);
    loadModels().then(value => {
      if (current) setCatalog(value);
    }, () => {
      if (current) setLoadFailed(true);
    });
    return () => { current = false; };
  }, [active, catalogVersion, loadModels, reload]);

  function updateChoice(value) {
    project.modelChoice = value;
    setChoice(value);
    try {
      const key = "uic-canvas-model:" + workspaceId;
      if (value.model || value.reasoningEffort) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch { /* Keep the project preference for this window when storage is unavailable. */ }
  }

  const groups = catalog?.groups || [];
  const findModel = route => groups.find(group => group.id === route?.provider)?.models.find(model => model.id === route.model);
  const defaultModel = findModel(catalog?.default);
  const selectedModel = choice.model ? findModel(choice) : defaultModel;
  const efforts = selectedModel?.reasoning?.efforts || [];
  const defaultEffort = (!choice.model && catalog?.default?.reasoningEffort) || selectedModel?.reasoning?.defaultEffort;
  const defaultEffortName = efforts.find(effort => effort.id === defaultEffort)?.name;
  const missingEffort = Boolean(choice.reasoningEffort) && !efforts.some(effort => effort.id === choice.reasoningEffort);
  const hasModels = groups.some(group => group.models.length > 0);
  // The existing default route can resolve independently of a provider's list operation.
  const canGenerate = (!choice.model && !choice.reasoningEffort) || (Boolean(selectedModel) && !missingEffort);
  const modelKey = choice.model ? JSON.stringify([choice.provider, choice.model]) : "";
  const modelStatus = loadFailed ? labels.loadFailed : !catalog ? labels.loadingModels : !hasModels ? labels.noModels : null;
  const defaultName = defaultModel?.name || catalog?.default?.model;
  const followCaption = defaultName ? labels.followModel + " · " + defaultName : labels.followModel;
  const effortCaption = !selectedModel ? "—" : !efforts.length ? labels.unsupported
    : defaultEffortName ? labels.defaultEffort + " · " + defaultEffortName : labels.defaultEffort;

  useEffect(() => {
    composing.current = observeComposition(input.current.ownerDocument);
    return () => {
      composing.current.dispose();
      inFlight.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    project.draft = draft;
    const field = input.current;
    field.style.height = "20px";
    if (field.scrollHeight > 20) field.style.height = Math.min(80, field.scrollHeight) + "px";
  }, [draft, project]);

  useLayoutEffect(() => {
    const panel = transcript.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [expanded, history, pending, error]);

  async function submit() {
    const prompt = draft.trim();
    if (!prompt || disabled || !canGenerate || inFlight.current) return;
    const request = new AbortController();
    inFlight.current = request;
    setError(null);
    setExpanded(true);
    setPending({ prompt, status: labels.pending });
    try {
      const result = await onGenerate({
        prompt, selection: choice,
        history: history.slice(-12),
        signal: request.signal,
        onStatus: status => {
          if (inFlight.current === request && !request.signal.aborted && typeof status === "string" && status.trim()) {
            setPending({ prompt, status });
          }
        },
      });
      if (request.signal.aborted) return;
      if (!result?.message?.trim()) throw new Error(labels.emptyReply);
      setHistory(previous => [...previous, { role: "user", content: prompt }, { role: "assistant", content: result.message }].slice(-12));
      setDraft(current => current.trim() === prompt ? "" : current);
    } catch (cause) {
      if (!request.signal.aborted) setError({ prompt, message: cause?.message || labels.failed });
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (!request.signal.aborted) setPending(null);
    }
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || composing.current?.guards(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    void submit();
  }

  const hasTranscript = Boolean(history.length || pending || error);
  const showTranscript = expanded && hasTranscript;
  const minimizeButton = jsx(Button, {
    className: "uic-agent-minimize", type: "button", variant: "ghost", size: "sm",
    "aria-label": labels.minimize, title: labels.minimize, "aria-expanded": true, "aria-controls": composerId,
    onClick: () => resizeChat(true), children: jsx(IconChevronDownOutlineMedium, { size: 18, "aria-hidden": true }),
  });
  const mark = jsx(IconSparkleRegular, { size: 19, "aria-hidden": true });
  const toggleLabel = expanded ? labels.close : labels.open;
  function entry(role, content, key, alert = false) {
    return jsxs("div", {
      className: "uic-agent-message", "data-role": role,
      children: [
        jsx("span", { className: "uic-agent-author", children: role === "user" ? labels.you : labels.title }),
        jsx("div", { className: "uic-agent-bubble", role: alert ? "alert" : undefined, children: content }),
      ],
    }, key);
  }

  const conversation = jsxs("div", {
    id: composerId, className: "uic-agent-expanded", inert: minimized ? "" : undefined,
    children: [
      showTranscript ? jsxs("div", {
        className: "uic-agent-panel",
        children: [
          minimizeButton,
          jsxs("div", {
            className: "uic-agent-transcript", id: transcriptId, ref: transcript,
            role: "log", "aria-live": "polite", "aria-label": labels.title,
            children: [
              ...history.map((message, index) => entry(message.role, message.content, index)),
              pending ? entry("user", pending.prompt, "pending-user") : null,
              pending ? entry("assistant", pending.status, "pending-agent") : null,
              error ? entry("user", error.prompt, "failed-user") : null,
              error ? entry("assistant", error.message, "failed-agent", true) : null,
            ],
          }),
        ],
      }) : null,
      jsxs("form", {
        className: "uic-agent-pill",
        onSubmit: event => { event.preventDefault(); void submit(); },
        children: [
          jsxs("div", {
            className: "uic-agent-prompt",
            children: [
              hasTranscript ? jsx(Button, {
                className: "uic-agent-circle uic-agent-mark", type: "button", size: "sm", variant: "ghost",
                "aria-expanded": expanded, "aria-controls": expanded ? transcriptId : undefined, "aria-label": toggleLabel,
                title: toggleLabel, onClick: () => setExpanded(open => !open), children: mark,
              }) : jsx("span", { className: "uic-agent-circle uic-agent-mark", children: mark }),
              jsx("textarea", {
                className: "uic-agent-input", ref: input, rows: 1, maxLength: 8000,
                "aria-label": labels.title, placeholder: labels.placeholder, value: draft, onKeyDown,
                onChange: event => setDraft(event.target.value),
              }),
              showTranscript ? null : minimizeButton,
            ],
          }),
          jsxs("div", {
            className: "uic-agent-footer",
            children: [
              jsxs("div", {
                className: "uic-agent-models",
                children: [
                  jsxs("label", { children: [
                    jsx("span", { children: labels.model }),
                    jsxs("select", {
                      "aria-label": labels.model, value: modelKey,
                      title: modelStatus || (choice.model ? selectedModel?.name || choice.model : followCaption),
                      disabled: (!hasModels && !choice.model) || Boolean(pending),
                      onChange: event => {
                        const key = event.currentTarget.value;
                        if (!key) return updateChoice({});
                        const [provider, model] = JSON.parse(key);
                        updateChoice({ provider, model });
                      },
                      children: [
                        jsx("option", { value: "", children: (!choice.model && modelStatus) || followCaption }),
                        choice.model && !selectedModel ? jsx("option", {
                          value: modelKey, disabled: true, children: choice.model + " · " + (modelStatus || labels.unavailable),
                        }) : null,
                        ...groups.map(group => jsx("optgroup", { label: group.name, children: group.models.map(model =>
                          jsx("option", { value: JSON.stringify([group.id, model.id]), children: model.name }, model.id)),
                        }, group.id)),
                      ],
                    }),
                  ] }),
                  jsxs("label", { children: [
                    jsx("span", { children: labels.effort }),
                    jsxs("select", {
                      "aria-label": labels.effort, value: choice.reasoningEffort || "",
                      title: choice.reasoningEffort ? efforts.find(e => e.id === choice.reasoningEffort)?.name || choice.reasoningEffort : effortCaption,
                      disabled: (!efforts.length && !choice.reasoningEffort) || Boolean(pending),
                      onChange: event => {
                        const next = { ...choice };
                        if (event.currentTarget.value) next.reasoningEffort = event.currentTarget.value;
                        else delete next.reasoningEffort;
                        updateChoice(next);
                      },
                      children: [
                        jsx("option", { value: "", children: choice.reasoningEffort && !selectedModel ? labels.defaultEffort : effortCaption }),
                        missingEffort ? jsx("option", {
                          value: choice.reasoningEffort, disabled: true, children: choice.reasoningEffort + " · " + (modelStatus || labels.unavailable),
                        }) : null,
                        ...efforts.map(effort => jsx("option", { value: effort.id, children: effort.name }, effort.id)),
                      ],
                    }),
                  ] }),
                  loadFailed || (catalog && (!selectedModel || missingEffort || catalog.failures?.length > 0)) ? jsx(Button, {
                    className: "uic-agent-reload", type: "button", variant: "ghost", size: "sm",
                    title: labels.reload, "aria-label": labels.reload, onClick: () => setReload(value => value + 1), children: labels.refresh,
                  }) : null,
                ],
              }),
              jsx(Button, {
                className: "uic-agent-circle", type: "submit", size: "sm", variant: "primary",
                disabled: disabled || Boolean(pending) || !canGenerate || !draft.trim(),
                "aria-label": pending?.status || labels.send, title: pending?.status || labels.send,
                children: pending ? jsx("span", { className: "uic-agent-wait", "aria-hidden": true })
                  : jsx(IconSendOutlineMedium, { size: 17, "aria-hidden": true }),
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const restoreLabel = pending ? labels.restore + " · " + pending.status : labels.restore;
  return jsxs("section", {
    className: "uic-canvas-agent", "aria-label": labels.title,
    children: [
      jsx("style", { children: canvasAgentCss }),
      conversation,
      jsxs(Button, {
        ref: dock, className: "uic-agent-dock", type: "button", variant: "outline", size: "sm",
        inert: minimized ? undefined : "", title: restoreLabel, "aria-label": restoreLabel,
        "aria-controls": composerId, "aria-expanded": false, onClick: () => resizeChat(false),
        children: [pending ? jsx("span", { className: "uic-agent-wait", "aria-hidden": true }) : mark, labels.title],
      }),
    ],
  });
}
