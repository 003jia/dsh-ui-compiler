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
    resize: "调整聊天框高度",
    pending: "Agent 正在分析需求…",
    failed: "处理失败，请重试。",
    emptyReply: "Agent 没有返回回复，请重试。",
    you: "你",
    toolCount: n => n + " 次工具调用", toolErrors: n => n + " 次失败",
    toolNames: { uic_canvas_read: "读取画布", uic_canvas_edit: "编辑画布", uic_canvas_place: "绘制画板", uic_update_plan: "更新任务计划" },
    worked: (m, s) => "工作用时 " + (m ? m + "分" : "") + s + "秒",
    plan: "任务计划", additions: "追加要求", steer: "追加到当前任务", steerHint: "补充要求，让 Agent 接着处理…",
    received: "已接收", sending: "正在发送…", addFailed: "追加失败，内容已保留，可以重试。",
    addLimit: "每次任务最多接收 8 条追加要求，每条最多 2000 字。", generating: "生成中",
    starting: "Agent 正在启动，请稍后再发送。", closed: "本次任务已结束，可以将这条要求作为下一条消息发送。",
    states: { queued: "等待中", running: "进行中", writing: "正在绘制", done: "已完成", failed: "失败", cancelled: "已停止" },
    toolSuccess: "成功", toolError: "失败",
    model: "模型", effort: "思考深度", followModel: "跟随 DSH", defaultEffort: "默认",
    unsupported: "不支持", unavailable: "已不可用", loadingModels: "正在加载…",
    noModels: "暂无可用模型", loadFailed: "加载失败", reload: "刷新模型列表", refresh: "刷新",
    attach: "添加图片或文件", uploading: "上传中…", uploadFailed: "上传失败", invalidPen: ".pen 文件无法解析",
    removeAttachment: "移除附件", dropFiles: "松开以添加文件",
    conversations: "画布会话", newConversation: "新会话", conversationFallback: "会话 {n}",
    intro: "告诉我你想设计什么，我会先出一版完整的可编辑稿，再按你的反馈迭代。",
  },
  en: {
    title: "Canvas Agent", invalidPen: "Could not parse .pen", uploadFailed: "Upload failed",
    placeholder: "Tell the agent what you want to design…",
    send: "Send to canvas agent",
    open: "Show conversation history",
    close: "Hide conversation history",
    minimize: "Minimize chat",
    restore: "Expand chat",
    resize: "Resize chat height",
    pending: "The agent is analyzing your request…",
    failed: "The request failed. Try again.",
    emptyReply: "The agent returned an empty reply. Try again.",
    you: "You",
    toolCount: n => n + (n === 1 ? " tool call" : " tool calls"),
    toolErrors: n => n + " failed",
    toolNames: { uic_canvas_read: "Read canvas", uic_canvas_edit: "Edit canvas", uic_canvas_place: "Draw artboard", uic_update_plan: "Update task plan" },
    worked: (m, s) => "Worked for " + (m ? m + "m " : "") + s + "s",
    plan: "Task plan", additions: "Follow-up", steer: "Add to current task", steerHint: "Add an instruction while the agent works…",
    received: "Received", sending: "Sending…", addFailed: "Could not add the instruction. Your text is ready to retry.",
    addLimit: "Add up to 8 instructions per task, with up to 2,000 characters each.", generating: "Generating",
    starting: "The agent is starting. Try again in a moment.", closed: "This task has finished. Send the instruction as your next message.",
    states: { queued: "Queued", running: "Working", writing: "Drawing", done: "Done", failed: "Failed", cancelled: "Stopped" },
    toolSuccess: "Succeeded", toolError: "Failed",
    conversations: "Canvas conversations", newConversation: "New chat", conversationFallback: "Chat {n}",
    intro: "Tell me what you want to design.",
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
  .uic-run-settings {
    pointer-events: auto; overflow: auto; max-height: min(45vh, 420px); padding: 12px;
    display: grid; gap: 9px; box-sizing: border-box; border-radius: 18px;
    border: 1px solid var(--dsw-alias-border-l2, GrayText);
    background: var(--dsw-alias-button-floating-fill, Canvas); box-shadow: 0 4px 18px rgb(0 0 0 / 12%);
  }
  .uic-run-settings header, .uic-run-rounds, .uic-run-models label {
    display: flex; gap: 6px; align-items: center; justify-content: space-between;
  }
  .uic-run-settings header strong, .uic-run-rounds { font-weight: 550; }
  .uic-run-count, .uic-run-modes, .uic-run-focus { display: grid; gap: 5px; }
  .uic-run-count { grid-template-columns: repeat(6,minmax(0,1fr)); }
  .uic-run-focus { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .uic-run-modes { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .uic-run-settings button, .uic-run-settings select, .uic-run-trigger {
    color: inherit; font: inherit; cursor: pointer;
  }
  .uic-run-option, .uic-run-settings select, .uic-run-trigger {
    background: var(--dsw-alias-button-floating-fill, Canvas); border: 1px solid var(--dsw-alias-border-l2, GrayText);
    border-radius: 9px; padding: 3px 6px; min-width: 0;
  }
  .uic-run-option[aria-pressed="true"], .uic-run-trigger[data-enabled="true"] {
    color: var(--dsw-alias-brand-text, CanvasText); background: var(--dsw-specific-bubble-highlight, ButtonFace);
    border-color: currentColor;
  }
  .uic-run-option small, .uic-run-total { display: block; color: var(--dsw-alias-label-secondary, GrayText); font-size: 11px; }
  .uic-run-option:disabled { opacity: .55; cursor: default; }
  .uic-run-modes button { text-align: start; padding: 6px 9px; }
  .uic-run-rounds { border-top: 1px solid var(--dsw-alias-border-l2, GrayText); padding-top: 9px; }
  .uic-run-models summary { cursor: pointer; }
  .uic-run-models select { max-width: 70%; }
  .uic-run-models label { margin-top: 5px; }
  .uic-run-trigger, .uic-run-close { display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
  .uic-run-trigger { flex: none; height: 26px; padding: 2px 7px; border-radius: 999px; }
  .uic-run-close { border: 0; border-radius: 50%; background: transparent; width: 26px; height: 26px; }
  .uic-run-trigger:hover, .uic-run-close:hover, .uic-run-option:hover { background: var(--dsw-alias-bg-module-platform, ButtonFace); }
  .uic-canvas-agent :is(.uic-run-trigger,.uic-run-close,.uic-run-option):focus-visible { outline: 2px solid var(--dsw-focus-ring-color, Highlight); }
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
  .uic-agent-attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 2px 4px 2px; }
  .uic-agent-chip {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    padding: 2px 4px 2px 8px; border-radius: 999px; font-size: 11px; line-height: 18px;
    background: var(--dsw-alias-bg-module-platform, ButtonFace);
    color: var(--dsw-alias-label-secondary, GrayText);
  }
  .uic-agent-chip[data-status="failed"] { color: var(--dsw-alias-state-error-primary, CanvasText); }
  .uic-agent-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uic-agent-chip-remove {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
    background: transparent; color: inherit; cursor: pointer;
  }
  .uic-agent-chip-remove:hover { background: var(--dsw-alias-interactive-bg-hover, Highlight); }
  .uic-agent-pill[data-dragging="true"] { border-color: var(--dsw-focus-ring-color, Highlight); }
  .uic-agent-drop {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    border-radius: 22px; font-size: 12px; pointer-events: none;
    color: var(--dsw-alias-label-secondary, GrayText);
    background: color-mix(in srgb, var(--dsw-alias-button-floating-fill, Canvas) 88%, transparent);
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
    display: flex; flex-direction: column; border-radius: 18px;
    max-height: min(30vh, 248px); min-height: 0; overflow: hidden;
  }
  .uic-canvas-agent .uic-agent-panel[data-working="true"] { max-height: min(43vh, 360px); }
  .uic-agent-grip {
    display: grid; place-items: center; align-self: center; flex: 0 0 18px; width: 90px;
    cursor: ns-resize; touch-action: none; user-select: none; border-radius: 8px;
  }
  .uic-agent-grip::before {
    content: ""; width: 30px; height: 3px; border-radius: 4px;
    background: var(--dsw-alias-label-secondary, GrayText); opacity: .55;
  }
  .uic-agent-grip:hover::before, .uic-agent-grip:focus-visible::before, .uic-agent-grip:active::before { opacity: 1; }
  .uic-agent-grip:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, Highlight); outline-offset: -2px; }
  @media (pointer: coarse) { .uic-agent-grip { flex-basis: 26px; width: 120px; } }
  .uic-agent-header {
    display: flex; align-items: center; gap: 6px; padding: 2px 10px 6px;
    border-bottom: 1px solid var(--dsw-alias-border-l2);
  }
  .uic-agent-header select {
    flex: 1 1 auto; min-width: 0; max-width: 100%; padding: 2px 4px;
    border: 0; border-radius: 8px; background: transparent; color: inherit;
    font: inherit; font-size: 12px; text-overflow: ellipsis; cursor: pointer;
  }
  .uic-agent-header select:hover, .uic-agent-header select:focus {
    background: var(--dsw-alias-bg-module-platform, ButtonFace); outline: none;
  }
  .uic-agent-new {
    flex: none; display: inline-flex; align-items: center; gap: 4px;
    min-height: 24px; padding: 0 8px; border-radius: 999px;
    border: .5px solid var(--dsw-alias-border-l2); background: transparent;
    color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  }
  .uic-agent-new:hover { background: var(--dsw-alias-bg-module-platform, ButtonFace); }
  .uic-agent-panel > .uic-agent-transcript {
    flex: 1 1 auto; min-height: 0; padding: 4px 14px 12px; overflow: auto;
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
  .uic-canvas-agent .uic-agent-tool-log {
    box-sizing: border-box; width: fit-content; max-width: 100%; padding: 0 4px;
    color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; line-height: 18px;
  }
  .uic-agent-tool-log summary { cursor: pointer; padding: 2px 0; width: fit-content; border-radius: 4px; }
  .uic-agent-tool-log summary:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, Highlight); outline-offset: 2px; }
  .uic-agent-tool-log ol { margin: 4px 0 6px; padding-inline-start: 18px; }
  .uic-agent-tool-log li { overflow-wrap: anywhere; padding: 2px 0; }
  .uic-agent-tool-log strong { font-weight: 550; color: var(--dsw-alias-label-primary, CanvasText); }
  .uic-agent-tool-log [data-error="true"] { color: var(--dsw-alias-state-error-primary, CanvasText); }
  .uic-agent-tool-log small { display: block; font: inherit; }
  .uic-canvas-agent .uic-agent-plan {
    width: 100%; margin: 2px 0 4px; padding: 6px 10px; box-sizing: border-box;
    border-radius: 10px; background: var(--dsw-alias-bg-module-platform, ButtonFace);
    font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary, CanvasText);
  }
  .uic-agent-plan summary { cursor: pointer; font-weight: 550; }
  .uic-agent-plan summary:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, Highlight); }
  .uic-agent-plan ul { list-style: none; padding: 0; margin: 6px 0 0; }
  .uic-agent-plan li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 6px; align-items: baseline; padding: 2px 0; }
  .uic-agent-plan li::before {
    content: ""; width: 6px; height: 6px; align-self: start; margin-top: 6px;
    border-radius: 50%; background: var(--uic-worker-ink, var(--dsw-alias-label-secondary, GrayText));
  }
  .uic-agent-plan li[data-status="queued"]::before { background: transparent; border: 1px solid var(--uic-worker-ink, GrayText); }
  .uic-agent-plan .uic-agent-workers { border-top: 1px solid var(--dsw-alias-border-weak, GrayText); padding-top: 4px; }
  .uic-agent-plan .uic-agent-worker-scope { grid-column: 2 / -1; margin-top: -4px; }
  .uic-agent-plan small, .uic-agent-message .uic-agent-add-status { font-size: 11px; color: var(--dsw-alias-label-secondary, GrayText); }
  .uic-agent-plan .uic-plan-tasks { grid-column: 2 / -1; margin: 0; }
  .uic-agent-plan .uic-plan-tasks li { grid-template-columns: 10px minmax(0, 1fr); padding: 1px 0; gap: 4px; }
  .uic-agent-plan .uic-plan-tasks li::before { display: none; }
  .uic-plan-tasks li[data-status="done"] { color: var(--dsw-alias-label-secondary, GrayText); }
  .uic-agent-author.uic-agent-crew { display: flex; flex-wrap: wrap; gap: 2px 12px; }
  .uic-agent-crew > span { display: inline-flex; gap: 5px; align-items: baseline; overflow-wrap: anywhere; }
  .uic-agent-crew > span::before { content: ""; align-self: center; width: 7px; height: 7px; border-radius: 50%; background: var(--uic-worker-ink); }
  .uic-agent-tool-log .uic-tool-icon { margin-inline-end: 4px; vertical-align: -2px; }
  .uic-agent-duration { margin-inline: 4px; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, GrayText); }
  .uic-agent-plan li > span, .uic-agent-worker-scope { overflow-wrap: anywhere; }
  .uic-agent-tool-log .uic-tool-group { list-style: none; margin-inline-start: -16px; font-weight: 550; }
  .uic-agent-tool-log li[data-active="true"] { color: var(--dsw-alias-label-primary, CanvasText); }
  .uic-agent-send-actions { display: flex; align-items: center; gap: 4px; }
  .uic-agent-add-notice { font-size: 12px; color: var(--dsw-alias-label-secondary, GrayText); margin: 2px 8px; }
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

const parallelText = {
  zh: {
    title: "并行 Agent", agents: "Agent 数量", collaborate: "分工协作", variants: "分别创建版本",
    divide: "各自负责不同画板", compare: "同一需求，独立出稿", variations: "逐一探索变体",
    off: "关闭", more: n => "追加 " + n + " 版", layout: "布局", style: "风格", creative: "创意",
    models: "各 Agent 的模型", inherit: "跟随主模型", close: "收起并行设置", stop: "停止生成",
    followup: "正在处理追加要求…",
    reading: "正在读取画布图层…", editing: "正在修改画布图层…", generating: "Agent 正在生成设计…",
    focus: "探索方向", begin: "正在启动画布 Agent…", planning: "正在分配任务…", writing: "正在把画板写入画布…",
    running: (done, total) => "正在生成画板 · " + done + " / " + total + " 已完成",
    hint: n => "本次将生成 " + n + " 张画板", unavailable: "模型已不可用",
  },
  en: {
    title: "Parallel agents", agents: "Number of agents", collaborate: "Divide the work", variants: "Separate versions",
    divide: "Split the brief across boards", compare: "Compare independent designs", variations: "Explore variations",
    off: "Off", more: n => "+" + n, layout: "Layout", style: "Style", creative: "Creative",
    models: "Models per agent", inherit: "Use main model", close: "Close run settings", stop: "Stop generation",
    followup: "Working on the follow-up…",
    reading: "Reading canvas layers…", editing: "Editing canvas layers…", generating: "The agent is generating the design…",
    focus: "Variation direction", begin: "Starting canvas agents…", planning: "Dividing the work…", writing: "Adding boards to canvas…",
    running: (done, total) => "Generating boards · " + done + " / " + total + " complete",
    hint: n => n + (n === 1 ? " board" : " boards") + " in this run", unavailable: "Model unavailable",
  },
};

const defaultCanvasRun = { count: 1, mode: "collaborate", iterations: 0, focus: "layout", models: [] };
const canvasAgentColors = ["#3874df", "#a650ba", "#008579", "#bd6423", "#7056c2", "#9a4866"];

function CanvasRunSettings({ value, onChange, labels, groups, panelId, onClose }) {
  const { jsx, jsxs } = react_jsx_runtime;
  const button = (name, caption, selected, onClick, detail, options = {}) => jsxs("button", {
    type: "button", className: "uic-run-option", "aria-label": name, "aria-pressed": selected, onClick, ...options,
    children: [caption, detail ? jsx("small", { children: detail }) : null],
  }, name);
  const update = delta => onChange({ ...value, ...delta });
  return jsxs("section", {
    id: panelId, className: "uic-run-settings", "aria-label": labels.title,
    onKeyDown: e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } },
    children: [
      jsxs("header", { children: [jsx("strong", { children: labels.title }), jsx("button", {
        type: "button", className: "uic-run-close", onClick: onClose, title: labels.close,
        "aria-label": labels.close, children: jsx(require("@deepseek-ai/dsh-client-ui-primitives").IconChevronDownOutlineMedium, { size: 17 }),
      })] }),
      jsx("div", { className: "uic-run-count", role: "group", "aria-label": labels.agents, children:
        [1, 2, 3, 4, 5, 6].map(n => button(n + " Agent", n, n === value.count, () => update({ count: n }), null, { autoFocus: n === value.count })),
      }),
      jsx("div", { className: "uic-run-modes", role: "group", "aria-label": labels.title, children: ["collaborate", "variants"].map((mode, i) =>
        button(labels[mode], labels[mode], mode === value.mode, () => update({ mode }), i ? labels.compare : labels.divide)) }),
      value.mode !== "variants" || value.count < 2 || !groups.length ? null : jsxs("details", { className: "uic-run-models", children: [
        jsx("summary", { children: labels.models }), ...Array.from({ length: value.count }, (_, index) => {
          const model = value.models[index];
          const key = model ? JSON.stringify([model.provider, model.model]) : "";
          const absent = model && !groups.some(g => g.id === model.provider && g.models.some(m => m.id === model.model));
          return jsxs("label", { children: ["Agent " + (index + 1), jsxs("select", {
            "aria-label": "Agent " + (index + 1) + " · " + labels.models, value: key,
            onChange: e => {
              const next = [...value.models];
              const route = e.currentTarget.value && JSON.parse(e.currentTarget.value);
              next[index] = route ? { provider: route[0], model: route[1] } : null;
              update({ models: next });
            },
            children: [jsx("option", { value: "", children: labels.inherit }),
              absent ? jsx("option", { value: key, disabled: true, children: model.model + " · " + labels.unavailable }) : null,
              ...groups.map(g => jsx("optgroup", { label: g.name, children: g.models.map(m =>
                jsx("option", { value: JSON.stringify([g.id, m.id]), children: m.name }, m.id)) }, g.id))],
          })] }, index);
        }),
      ] }),
      jsxs("label", { className: "uic-run-rounds", children: [labels.variations, jsx("select", {
        "aria-label": labels.variations, value: value.iterations,
        onChange: e => update({ iterations: Number(e.currentTarget.value) }), children: [0, 1, 2, 3, 4, 5].map(n =>
          jsx("option", { value: n, children: n ? labels.more(n) : labels.off }, n)),
      })] }),
      jsx("div", { className: "uic-run-focus", role: "group", "aria-label": labels.focus,
        children: ["layout", "style", "creative"].map(f => button(labels[f], labels[f], f === value.focus, () => update({ focus: f }), null, { disabled: !value.iterations })),
      }),
      value.count > 1 || value.iterations ? jsx("small", { className: "uic-run-total", children: labels.hint(value.count * (1 + value.iterations)) }) : null,
    ],
  });
}


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
  workspaceId, active, loadModels, catalogVersion, uploadFile,
  conversationId, conversations = [], onNewConversation, onSelectConversation }) {
  const { jsx, jsxs } = react_jsx_runtime;
  const { useEffect, useId, useLayoutEffect, useRef, useState } = react;
  const { Button, IconSparkleRegular, IconSendOutlineMedium, IconChevronDownOutlineMedium, IconSearchOutlineRegular, IconEditOutlineRegular,
    IconPlusOutlineRegular, IconCloseOutlineRegular, observeComposition } =
    require("@deepseek-ai/dsh-client-ui-primitives");
  const labels = locale?.startsWith("zh") ? canvasAgentText.zh : canvasAgentText.en;
  const runs = locale?.startsWith("zh") ? parallelText.zh : parallelText.en;
  const runPanelId = useId();
  const runTrigger = useRef(null);
  const [runOpen, setRunOpen] = useState(false);
  const [run, setRun] = useState(() => project.canvasRun || defaultCanvasRun);
  const useBatch = run.count > 1 || run.iterations > 0;
  const closeRun = () => { setRunOpen(false); runTrigger.current?.focus(); };
  const transcriptId = useId();
  const composerId = useId();
  const input = useRef(null);
  const dock = useRef(null);
  const moveFocus = useRef(false);
  const transcript = useRef(null);
  const followTranscript = useRef(true);
  const composing = useRef(null);
  const inFlight = useRef(null);
  const [draft, setDraft] = useState(() => project.draft);
  const [history, setHistory] = useState(() => initialTurns.length === 0
    ? [{ role: "assistant", content: labels.intro }]
    : initialTurns.flatMap(turn => [
      { role: "user", content: turn.prompt },
      { role: "assistant", content: formatReply(turn), toolCalls: turn.toolCalls, plan: turn.plan, failed: turn.failed },
    ]));
  const [expanded, setExpanded] = useState(true);
  const [minimized, setMinimized] = useState(() => Boolean(project.chatMinimized));
  const panelRef = useRef(null);
  const resizeGesture = useRef(null);
  const heightKey = "uic-canvas-chat-height:" + workspaceId;
  const [preferredHeight, setPreferredHeight] = useState(() => {
    let value = project.chatHeight;
    try { value ??= Number(localStorage.getItem(heightKey)); } catch { /* Use this project's in-memory choice. */ }
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const [heightRange, setHeightRange] = useState({ min: 96, max: 720, now: 160 });
  const [pending, setPending] = useState(null);
  const [addNotice, setAddNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [choice, setChoice] = useState(() => project.modelChoice || readCanvasModelChoice(workspaceId));
  const [catalog, setCatalog] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0)
  const [attachments, setAttachments] = useState([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef(null)
  const uploading = attachments.some(item => item.status === "uploading");

  function measurePanel() {
    const panel = panelRef.current;
    const surface = panel?.closest?.(".uic-canvas-agent")?.parentElement;
    if (!surface) return null;
    const { height, bottom } = panel.getBoundingClientRect();
    if (!height || !bottom) return null;
    // The bottom edge is anchored to the input. Leave the canvas toolbar and a small margin clear.
    const max = Math.max(1, Math.floor(bottom - Math.max(0, surface.getBoundingClientRect().top) - 44));
    const min = Math.min(108, max);
    return { min, max, now: Math.min(max, Math.max(min, Math.round(height))) };
  }
  useLayoutEffect(() => {
    if (!active || !expanded || minimized || runOpen || !panelRef.current) return;
    const panel = panelRef.current;
    const surface = panel.closest?.(".uic-canvas-agent")?.parentElement;
    if (!surface) return;
    const refresh = () => {
      const range = measurePanel();
      if (range) setHeightRange(old => old.now === range.now && old.min === range.min && old.max === range.max ? old : range);
    };
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(surface);
    observer.observe(panel);
    const form = panel.nextElementSibling;
    if (form) observer.observe(form);
    return () => { observer.disconnect(); resizeGesture.current = null; };
  }, [active, expanded, minimized, runOpen]);
  function rememberHeight(value) {
    project.chatHeight = value;
    try { localStorage.setItem(heightKey, String(value)); } catch { /* The live project still remembers the size. */ }
  }
  function beginResize(event) {
    if (event.button !== 0 || event.isPrimary === false || resizeGesture.current) return;
    const range = measurePanel();
    if (!range) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGesture.current = { id: event.pointerId, y: event.clientY, start: range.now, range, original: preferredHeight, last: null };
  }
  function moveResize(event) {
    const drag = resizeGesture.current;
    if (drag?.id !== event.pointerId) return;
    const delta = drag.y - event.clientY;
    if (drag.last === null && Math.abs(delta) < 3) return;
    drag.last = Math.min(drag.range.max, Math.max(drag.range.min, Math.round(drag.start + delta)));
    setPreferredHeight(drag.last);
  }
  function endResize(event, cancel = false) {
    const drag = resizeGesture.current;
    if (drag?.id !== event.pointerId) return;
    resizeGesture.current = null;
    if (cancel) setPreferredHeight(drag.original);
    else if (drag.last !== null) rememberHeight(drag.last);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyResize(event) {
    const range = measurePanel();
    if (!range || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const requested = event.key === "Home" ? range.min : event.key === "End" ? range.max
      : range.now + (event.key === "ArrowUp" ? 24 : -24);
    const value = Math.min(range.max, Math.max(range.min, requested));
    setPreferredHeight(value);
    rememberHeight(value);
  }

  function resizeChat(compact) {
    moveFocus.current = true;
    project.chatMinimized = compact;
    setRunOpen(false);
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
    if (panel && followTranscript.current) panel.scrollTop = panel.scrollHeight;
  }, [expanded, history, pending, error]);

  function removeAttachment(key) {
    setAttachments(current => current.filter(item => item.key !== key))
  }

  async function uploadList(files) {
    const list = [...(files ?? [])].filter(file => file && file.size > 0)
    if (list.length === 0 || typeof uploadFile !== "function") return
    const pendingUploads = list.map(file => ({
      key: [file.name, file.size, file.lastModified, Math.random()].join(":"),
      name: file.name, mimeType: file.type || "application/octet-stream", bytes: file.size, status: "uploading",
    }))
    setAttachments(current => [...current, ...pendingUploads])
    for (let index = 0; index < list.length; index++) {
      const key = pendingUploads[index].key
      try {
        const asset = await uploadFile(list[index])
        setAttachments(current => current.map(item => item.key === key
          ? { ...item, ...asset, key, status: "ready" }
          : item))
      } catch (error) {
        setAttachments(current => current.map(item => item.key === key ? { ...item, key, status: "failed", error: error.message } : item))
      }
    }
  }

  function onDrop(event) {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    void uploadList(event.dataTransfer?.files)
  }

  async function submit() {
    const prompt = draft.trim();
    if (!prompt || disabled) return;
    if (inFlight.current) {
      const request = inFlight.current;
      if (!request.append || request.adding || request.signal.aborted) return;
      // Reuse the ID if a response was lost after the host had accepted the instruction.
      if (request.attempt?.text !== prompt) request.attempt = { id: crypto.randomUUID(), text: prompt };
      const addition = request.attempt;
      request.adding = true;
      setAdding(true);
      setAddNotice("");
      try {
        const status = await request.append(addition.id, prompt);
        if (request.signal.aborted) return;
        request.attempt = null;
        request.accepted = [...(request.accepted || []).filter(item => item.id !== addition.id), { ...addition, status: status || "queued" }];
        setDraft(value => value.trim() === prompt ? "" : value);
        if (inFlight.current === request) setPending(value => value && { ...value, accepted: request.accepted });
        followTranscript.current = true;
      } catch (cause) {
        if (!request.signal.aborted) setAddNotice(cause?.code === "closed" ? labels.closed : cause?.code === "starting" ? labels.starting
          : cause?.code === "invalid_request" ? labels.addLimit : labels.addFailed);
      } finally {
        request.adding = false;
        if (input.current) setAdding(false);
      }
      return;
    }
    if (!canGenerate || uploading) return;
    const request = new AbortController();
    inFlight.current = request;
    setError(null);
    setAddNotice("");
    setDraft("");
    followTranscript.current = true;
    setExpanded(true);
    setRunOpen(false);
    setPending({ prompt, status: useBatch ? runs.begin : labels.pending });
    try {
      const ready = attachments.filter(item => item.status === "ready")
      let plan;
      if (useBatch) {
        const models = run.mode === "variants" && run.count > 1
          ? Array.from({length: run.count}, (_, i) => run.models[i] || null) : [];
        plan = { count: run.count, mode: run.mode, iterations: run.iterations, focus: run.focus, models };
      }
      const result = await onGenerate({
        prompt, selection: choice, plan, runLabels: runs,
        attachments: ready.map(({ id, name, mimeType }) => ({ id, name, mimeType })),
        history: history.slice(-12),
        signal: request.signal,
        onReady: append => {
          if (inFlight.current !== request || request.signal.aborted) return;
          request.append = append;
          setPending(value => value && { ...value, canAppend: true });
        },
        onProgress: plan => {
          if (inFlight.current !== request || request.signal.aborted) return;
          request.plan = plan;
          setPending(value => value && { ...value, plan });
        },
        onStatus: status => {
          if (inFlight.current === request && !request.signal.aborted && typeof status === "string" && status.trim()) {
            setPending(value => value && { ...value, status });
          }
        },
      });
      if (request.signal.aborted) return;
      if (!result?.message?.trim()) throw new Error(labels.emptyReply);
      setHistory(previous => [...previous, { role: "user", content: prompt }, {
        role: "assistant", content: result.message, toolCalls: result.toolCalls, plan: result.plan,
      }].slice(-12));
      const sent = new Set(ready.map(item => item.key));
      setAttachments(current => current.filter(item => !sent.has(item.key)));
    } catch (cause) {
      if (!request.signal.aborted) {
        setError({ prompt, message: cause?.message || labels.failed, toolCalls: cause?.toolCalls, plan: cause?.plan || request.plan });
        setDraft(value => value || prompt);
      }
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (input.current) {
        if (request.signal.aborted) setDraft(value => value || prompt);
        setPending(null);
      }
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
  function workPlan(plan, live) {
    const slots = Array.isArray(plan?.slots) ? plan.slots : [];
    const planned = slots.some(slot => slot.tasks?.length);
    const steps = !planned && Array.isArray(plan?.steps) ? plan.steps : [];
    if (!steps.length && !slots.length) return null;
    function row(item, worker) {
      const workerName = "Agent " + item.index;
      const title = worker ? workerName + (item.title && item.title !== workerName ? " · " + item.title : "") : item.title;
      const status = worker && item.status === "running"
        ? labels.toolNames[item.activeTool?.name] || labels.generating : labels.states[item.status];
      return jsxs("li", {
        "data-status": item.status, style: worker ? { "--uic-worker-ink": canvasAgentColors[item.index - 1] } : undefined,
        children: [
          jsx("span", { children: title }),
          jsx("small", { children: status || "" }),
          worker && item.scope && !item.tasks?.length ? jsx("small", { className: "uic-agent-worker-scope", children: item.scope }) : null,
          worker && item.tasks?.length ? jsx("ul", { className: "uic-plan-tasks", children: item.tasks.map((task, i) => jsxs("li", {
            "data-status": task.status, children: [
              jsx("span", { "aria-label": labels.states[task.status], title: labels.states[task.status],
                children: task.status === "done" ? "✓" : task.status === "running" ? "◐" : "○" }),
              jsx("span", { children: task.title }),
            ],
          }, i)) }) : null,
        ],
      }, worker ? item.index : title);
    }
    return jsxs("details", {
      className: "uic-agent-plan", open: live || undefined, children: [
        jsx("summary", { children: labels.plan }),
        steps.length ? jsx("ul", { children: steps.map(step => row(step, false)) }) : null,
        slots.length ? jsx("ul", { className: steps.length ? "uic-agent-workers" : undefined,
          children: slots.map(slot => row(slot, true)) }) : null,
      ],
    });
  }

  function toolLog(toolCalls, plan, live) {
    const slots = Array.isArray(plan?.slots) ? plan.slots : [];
    const calls = (Array.isArray(toolCalls) && toolCalls.length ? toolCalls : slots.flatMap(slot =>
      (slot.toolCalls || []).map(call => ({ ...call, agentIndex: slot.index })))).filter(call =>
      call && Object.hasOwn(labels.toolNames, call.name) && (call.status === "success" || call.status === "error"));
    if (live) for (const slot of slots) {
      const active = slot.activeTool;
      if (active && Object.hasOwn(labels.toolNames, active.name)) calls.push({
        ...active, status: "running", agentIndex: slot.index, round: slot.round,
      });
    }
    if (!calls.length) return null;
    const failures = calls.filter(call => call.status === "error").length;
    const groups = new Map();
    for (const call of calls) {
      const key = call.agentIndex ? [call.agentIndex, call.round || 0, call.additionId || ""].join(":") : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }
    return jsxs("details", {
      className: "uic-agent-tool-log",
      children: [
        jsx("summary", { children: labels.toolCount(calls.length) + (failures ? " · " + labels.toolErrors(failures) : "") }),
        ...Array.from(groups, ([key, entries]) => {
          const first = entries[0];
          const target = slots.find(slot => slot.index === first.agentIndex)?.title;
          return jsx("ol", { children: [
            key ? jsx("li", { className: "uic-tool-group", children: "Agent " + first.agentIndex
              + (first.round ? " · V" + (first.round + 1) : "") + (first.additionId ? " · " + labels.additions
                : target && target !== "Agent " + first.agentIndex ? " · " + target : "") }) : null,
            ...entries.map((call, i) => jsxs("li", { "data-active": call.status === "running", children: [
              jsx(call.name === "uic_canvas_read" ? IconSearchOutlineRegular : IconEditOutlineRegular,
                { size: 12, className: "uic-tool-icon", "aria-hidden": true }),
              jsx("strong", { title: call.name, children: labels.toolNames[call.name] }),
              typeof call.target === "string" && call.target ? " · " + call.target : null,
              jsx("span", { "data-error": call.status === "error", children: " · " + (call.status === "running"
                ? labels.states.running : call.status === "error" ? labels.toolError : labels.toolSuccess) }),
              typeof call.summary === "string" && call.summary ? jsx("small", { children: call.summary }) : null,
            ] }, i)),
          ] }, key);
        }),
      ],
    });
  }

  function additionEntries(plan, accepted) {
    const additions = new Map();
    for (const addition of [...(accepted || []), ...(plan?.additions || [])]) {
      if (addition?.id && addition.text) additions.set(addition.id, addition);
    }
    return Array.from(additions.values(), addition => jsxs("div", {
      className: "uic-agent-message", "data-role": "user", children: [
        jsx("span", { className: "uic-agent-author", children: labels.additions }),
        jsx("div", { className: "uic-agent-bubble", children: addition.text }),
        jsx("small", { className: "uic-agent-add-status", children: labels.states[addition.status] || labels.received }),
      ],
    }, addition.id));
  }

  function entry(role, content, key, alert = false, toolCalls, plan, live = false) {
    const crew = role === "assistant" && Array.isArray(plan?.slots) ? plan.slots : [];
    const seconds = !live && Number.isFinite(plan?.elapsedMs) && plan.elapsedMs >= 0 ? Math.floor(plan.elapsedMs / 1000) : null;
    return jsxs("div", {
      className: "uic-agent-message", "data-role": role,
      children: [
        crew.length ? jsx("div", { className: "uic-agent-author uic-agent-crew", children: crew.map(slot => {
          const model = findModel(slot.model)?.name || slot.modelLabel || slot.model?.model;
          return jsx("span", { style: { "--uic-worker-ink": canvasAgentColors[slot.index - 1] },
            children: "Agent " + slot.index + (model ? " · " + model : "") }, slot.index);
        }) }) : jsx("span", { className: "uic-agent-author", children: role === "user" ? labels.you : labels.title }),
        role === "assistant" ? workPlan(plan, live) : null,
        role === "assistant" ? toolLog(toolCalls, plan, live) : null,
        jsx("div", { className: "uic-agent-bubble", role: alert ? "alert" : undefined, children: content }),
        seconds !== null ? jsx("small", { className: "uic-agent-duration", children: labels.worked(Math.floor(seconds / 60), seconds % 60) }) : null,
      ],
    }, key);
  }

  const conversation = jsxs("div", {
    id: composerId, className: "uic-agent-expanded", inert: minimized ? "" : undefined,
    children: [
      runOpen ? jsx(CanvasRunSettings, {
        labels: runs, value: run, groups, panelId: runPanelId, onClose: closeRun,
        onChange: value => { project.canvasRun = value; setRun(value); },
      }) : showTranscript ? jsxs("div", {
        ref: panelRef, className: "uic-agent-panel", "data-working": pending ? "true" : undefined,
        style: preferredHeight === null ? undefined : {
          height: Math.min(heightRange.max, Math.max(heightRange.min, preferredHeight)) + "px", maxHeight: heightRange.max + "px",
        },
        children: [
          jsx("div", { className: "uic-agent-grip", role: "separator", tabIndex: 0,
            "aria-label": labels.resize, title: labels.resize, "aria-orientation": "horizontal", "aria-controls": transcriptId,
            "aria-valuemin": heightRange.min, "aria-valuemax": heightRange.max, "aria-valuenow": heightRange.now,
            onPointerDown: beginResize, onPointerMove: moveResize, onPointerUp: event => { moveResize(event); endResize(event); },
            onPointerCancel: event => endResize(event, true), onLostPointerCapture: event => endResize(event), onKeyDown: keyResize,
          }),
          jsxs("div", {
            className: "uic-agent-header",
            children: [
              jsxs("select", {
                "aria-label": labels.conversations, value: conversationId ?? "",
                disabled: Boolean(pending) || conversations.length === 0,
                onChange: event => { if (event.currentTarget.value && event.currentTarget.value !== conversationId) onSelectConversation?.(event.currentTarget.value) },
                children: (conversations.length === 0
                  ? [{ id: conversationId ?? "", title: "", updatedAt: "", turnCount: 0 }]
                  : conversations
                ).map((entry, index) => jsx("option", {
                  value: entry.id,
                  children: entry.title || labels.conversationFallback.replace("{n}", String(index + 1)),
                }, entry.id)),
              }),
              jsx("button", {
                type: "button", className: "uic-agent-new", disabled: Boolean(pending),
                onClick: () => onNewConversation?.(),
                children: [jsx(IconPlusOutlineRegular, { size: 12, "aria-hidden": true }), labels.newConversation],
              }),
              minimizeButton,
            ],
          }),
          jsxs("div", {
            className: "uic-agent-transcript", id: transcriptId, ref: transcript,
            onScroll: event => { const node = event.currentTarget; followTranscript.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; },
            role: "log", "aria-live": "polite", "aria-label": labels.title,
            children: [
              ...history.flatMap((message, index) => [...additionEntries(message.plan),
                entry(message.role, message.content, index, message.failed, message.toolCalls, message.plan)]),
              pending ? entry("user", pending.prompt, "pending-user") : null,
              ...additionEntries(pending?.plan, pending?.accepted),
              pending ? entry("assistant", pending.status, "pending-agent", false, undefined, pending.plan, true) : null,
              error ? entry("user", error.prompt, "failed-user") : null,
              ...additionEntries(error?.plan),
              error ? entry("assistant", error.message, "failed-agent", true, error.toolCalls, error.plan) : null,
            ],
          }),
        ],
      }) : null,
      jsxs("form", {
        className: "uic-agent-pill",
        "data-dragging": dragging ? "true" : undefined,
        onSubmit: event => { event.preventDefault(); void submit(); },
        onDragOver: event => { event.preventDefault(); event.stopPropagation(); setDragging(true) },
        onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) },
        onDrop: event => onDrop(event),
        children: [
          jsx("input", {
            ref: fileInput, type: "file", multiple: true, hidden: true,
            onChange: event => { void uploadList(event.target.files); event.target.value = "" },
          }),
          attachments.length === 0 ? null : jsx("div", {
            className: "uic-agent-attachments",
            children: attachments.map(item => jsxs("span", {
              className: "uic-agent-chip", "data-status": item.status,
              children: [
                jsx("span", { className: "uic-agent-chip-name", title: item.name, children: item.name }),
                item.status === "uploading" ? labels.uploading : item.status === "failed" ? (item.error === "invalid_pen" ? labels.invalidPen : labels.uploadFailed) : null,
                jsx("button", {
                  type: "button", className: "uic-agent-chip-remove", "aria-label": labels.removeAttachment,
                  onClick: () => removeAttachment(item.key),
                  children: jsx(IconCloseOutlineRegular, { size: 12, "aria-hidden": true }),
                }),
              ],
            }, item.key)),
          }),
          dragging ? jsx("div", { className: "uic-agent-drop", children: labels.dropFiles }) : null,
          addNotice ? jsx("div", { className: "uic-agent-add-notice", role: "status", children: addNotice }) : null,
          jsxs("div", {
            className: "uic-agent-prompt",
            children: [
              jsx(Button, {
                className: "uic-agent-circle", type: "button", size: "sm", variant: "ghost",
                "aria-label": labels.attach, title: labels.attach, disabled: disabled || Boolean(pending),
                onClick: () => fileInput.current?.click(),
                children: jsx(IconPlusOutlineRegular, { size: 18, "aria-hidden": true }),
              }),
              hasTranscript ? jsx(Button, {
                className: "uic-agent-circle uic-agent-mark", type: "button", size: "sm", variant: "ghost",
                "aria-expanded": expanded, "aria-controls": expanded ? transcriptId : undefined, "aria-label": toggleLabel,
                title: toggleLabel, onClick: () => setExpanded(open => !open), children: mark,
              }) : jsx("span", { className: "uic-agent-circle uic-agent-mark", children: mark }),
              jsx("textarea", {
                className: "uic-agent-input", ref: input, rows: 1, maxLength: pending ? 2000 : 8000,
                "aria-label": labels.title, placeholder: pending ? labels.steerHint : labels.placeholder, value: draft, onKeyDown,
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
                  jsxs("button", {
                    ref: runTrigger, type: "button", className: "uic-run-trigger", disabled: Boolean(pending),
                    "aria-expanded": runOpen, "aria-controls": runPanelId, "aria-label": runs.title + " · " + run.count,
                    title: runs.title, "data-enabled": useBatch, onClick: () => setRunOpen(open => !open),
                    children: [jsx(require("@deepseek-ai/dsh-client-ui-primitives").IconBranchOutlineRegular, { size: 15, "aria-hidden": true }), run.count],
                  }),
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
              jsxs("div", { className: "uic-agent-send-actions", children: [pending ? jsx(Button, {
                className: "uic-agent-circle", type: "button", size: "sm", variant: "ghost",
                "aria-label": runs.stop, title: runs.stop, onClick: () => inFlight.current?.abort(),
                children: jsx("span", { "aria-hidden": true, children: "■" }),
              }) : null, jsx(Button, {
                className: "uic-agent-circle", type: "submit", size: "sm", variant: "primary",
                disabled: disabled || !draft.trim() || (pending ? !pending.canAppend || adding : uploading || !canGenerate),
                "aria-label": pending ? labels.steer : labels.send, title: pending ? labels.steer : labels.send,
                children: adding ? jsx("span", { className: "uic-agent-wait", "aria-hidden": true })
                  : jsx(IconSendOutlineMedium, { size: 17, "aria-hidden": true }),
              })] }),
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
