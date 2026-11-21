/** Persistent compiler surfaces in the official DSH main panel. */
function mountCompilerSidebarAction(ctx, getEditorWorkbenchHost, getCanvasAgent) {
  const {
    Button, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconCodeOutlineRegular,
    IconEditOutlineRegular, IconPlayOutlineRegular, Toast, Tooltip,
  } = require("@deepseek-ai/dsh-client-ui-primitives");
  const { IconPanelLeftOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
  const { jsx, jsxs } = react_jsx_runtime;
  const { useLayoutEffect, useRef, useState, useSyncExternalStore } = react;
  const namespace = "uic-sidebar-entry";
  const canvasId = "uic-canvas";
  const previewId = "uic-preview";
  const route = "/_dsh/dsh-openpencil/ui-compiler";
  const disposed = new AbortController();
  const copy = {
    zh: {
      title: "UI 设计编译器",
      canvas: "设计画布",
      preview: "页面预览",
      chat: "返回项目对话",
      project: "项目",
      showProjectBar: "显示项目栏",
      widenCanvas: "加宽画布",
      projectRequired: "请在 DSH 左侧选择项目中的对话，或点项目旁的「新会话」。",
      opening: "正在打开画布…",
      busy: "请回到上一张画布，保存或关闭后再打开此项目。",
      missing: "找不到当前项目或设计稿文件。",
      unavailable: "画布编辑器暂时无法打开，请重试。",
      previewLoading: "正在生成页面预览…",
      previewSaved: "基于已保存的稿件",
      previewFailed: "页面预览更新失败。",
      export: "导出前端",
      exporting: "正在导出…",
      exportReady: "前端入口",
      exportFailed: "前端导出失败，请重试。",
      exportConflict: "已有导出包含手动修改，文件已保留。",
      exportChanged: "设计稿已更新，请刷新预览后重新导出。",
      retry: "重试",
      close: "关闭画布",
      closeFailed: "画布关闭失败，请重试。",
      agentOffline: "画布 Agent 暂时无法连接，请重试。",
      model_unavailable: "当前画布模型不可用，请重新选择。",
      unsupported_effort: "所选思考深度已不可用，请重新选择。",
      model_failed: "当前 DSH 模型请求失败，请重试。",
      model_timeout: "模型响应超时，请重试。",
      invalid_request: "请输入 8000 字以内的设计需求。",
      invalid_design: "模型返回的图层无法绘制，请重试或补充需求。",
      busyAgent: "上一条画布需求仍在处理中。",
      canvas_changed: "画布内容已变化，请核对后再发送。",
      canvas_unavailable: "请等画布加载完成后再发送。",
      revision_conflict: "这张画板有新的手动修改，请说明要保留的内容后再试。",
      edit_failed: "写入图层失败，请核对当前画布后再试。",
      historyReadFailed: "画布已打开，暂时无法读取历史对话。",
      historyWriteFailed: "本次操作已完成，但对话未能保存。",
      added: "已添加画板", revised: "已更新画板",
    },
    en: {
      title: "UI Design Compiler",
      canvas: "Design canvas",
      preview: "Page preview",
      chat: "Back to project chat",
      project: "Project",
      showProjectBar: "Show project sidebar",
      widenCanvas: "Widen canvas",
      projectRequired: "Select a project conversation in the DSH sidebar or start a new chat in that project.",
      opening: "Opening canvas…",
      busy: "Return to the previous canvas and save or close it before opening this project.",
      missing: "The current project or its design file could not be found.",
      unavailable: "The canvas could not be opened. Try again.",
      previewLoading: "Building page preview…",
      previewSaved: "From the saved design",
      previewFailed: "The page preview could not be updated.",
      export: "Export frontend",
      exporting: "Exporting…",
      exportReady: "Frontend entry",
      exportFailed: "The frontend export failed. Try again.",
      exportConflict: "The existing export contains manual edits. The files have been preserved.",
      exportChanged: "The design has changed. Refresh the preview and export again.",
      retry: "Retry",
      close: "Close canvas",
      closeFailed: "The canvas could not be closed. Try again.",
      agentOffline: "The canvas agent is unavailable. Try again.",
      model_unavailable: "The selected canvas model is unavailable. Choose another model.",
      unsupported_effort: "The selected reasoning effort is unavailable. Choose another level.",
      model_failed: "The selected DSH model request failed. Try again.",
      model_timeout: "The model request timed out. Try again.",
      invalid_request: "Enter a design request of up to 8,000 characters.",
      invalid_design: "The model returned an unusable design. Retry or refine the request.",
      busyAgent: "The previous canvas request is still running.",
      canvas_changed: "The canvas changed. Review it before retrying.",
      canvas_unavailable: "Wait for the canvas to finish loading before sending.",
      revision_conflict: "This frame has new manual edits. Review them before retrying.",
      edit_failed: "Could not apply the design. Review the canvas before retrying.",
      historyReadFailed: "The canvas is open, but its conversation could not be loaded.",
      historyWriteFailed: "The request completed, but the conversation could not be saved.",
      added: "Added frame", revised: "Updated frame",
    },
  };
  const listeners = new Set();
  let surface = { panelId: null, workspace: undefined, previewStatus: "idle", canvasWide: true };
  const projects = new Map();
  let activeAnchor;
  let previewRequest;
  let exportRequest;
  let workspaceLifetime = new AbortController();
  const surfaces = {
    getSnapshot: () => surface,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  function publish(changes) {
    surface = { ...surface, ...changes };
    for (const listener of listeners) listener();
  }

  function selectedWorkspace() {
    const { byId } = ctx.sessions.list.getSnapshot();
    const main = Object.values(byId).filter(session => (session.retainedBy.mainView ?? 0) > 0);
    if (main.length !== 1) return;
    const session = main[0];
    const { items } = ctx.workspaces.list.getSnapshot();
    return items.find(item => item.sessionIds.includes(session.id))
      ?? (session.parentSessionId ? items.find(item => item.sessionIds.includes(session.parentSessionId)) : undefined);
  }

  const sessionRemote = ctx.remote.session;
  async function loadCanvasModels() {
    const result = await sessionRemote.modelCatalog();
    if (!result.ok) throw new Error("Canvas model catalog unavailable");
    return result.value;
  }

  ctx.inject(["remote.session"], scope => {
    const refresh = () => publish({ modelCatalogVersion: (surface.modelCatalogVersion || 0) + 1 });
    scope.on("connection/reset", refresh);
    for (const event of ["llm/adapters-updated", "llm/models-updated", "settings/document-updated",
      "credentials/record-updated", "credentials/reference-updated"]) scope.remote.$on(event, refresh);
    refresh();
  });

  function projectState(id) {
    if (!projects.has(id)) projects.set(id, { draft: "" });
    return projects.get(id);
  }

  function syncWorkspace() {
    const workspace = selectedWorkspace();
    if (surface.workspace?.workspaceId !== workspace?.workspaceId) {
      workspaceLifetime.abort();
      workspaceLifetime = new AbortController();
      previewRequest?.abort();
      exportRequest?.abort();
      publish({ workspace, preview: undefined, previewStatus: "idle", exportStatus: undefined, entryPath: undefined });
    } else if (surface.workspace?.title !== workspace?.title || surface.workspace?.path !== workspace?.path) {
      publish({ workspace });
    }
    return workspace;
  }

  ctx.effect(() => {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!disposed.signal.aborted) syncWorkspace(); });
    };
    const stopSessions = ctx.sessions.list.subscribe(schedule);
    const stopWorkspaces = ctx.workspaces.list.subscribe(schedule);
    syncWorkspace();
    return () => { stopSessions(); stopWorkspaces(); };
  }, "UI compiler: follow the current DSH project");

  function workspaceTitle(workspace) {
    return workspace?.title || workspace?.path?.split(/[\\/]/).filter(Boolean).pop() || workspace?.workspaceId;
  }

  ctx.effect(() => ctx.locale.register(namespace, copy), "UI compiler: locale");

  ctx.effect(() => {
    const root = document.documentElement;
    const style = document.createElement("style");
    style.dataset.uicAppearance = "rounded";
    style.textContent = desktopAppearanceCss;
    document.head.append(style);
    root.dataset.uicAppearance = "rounded";
    return () => {
      style.remove();
      if (!document.querySelector('style[data-uic-appearance="rounded"]') && root.dataset.uicAppearance === "rounded") {
        delete root.dataset.uicAppearance;
      }
    };
  }, "UI compiler: desktop appearance");

  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `
      :has(> .uic-sidebar-entry):has(> :not(.uic-sidebar-entry)) {
        flex-direction: column;
      }
      .uic-sidebar-entry { display: flex; flex: 1 1 0; min-width: 0; align-items: center; gap: 4px; }
      .uic-sidebar-entry[data-wide="false"] { flex-direction: column; }
      .uic-sidebar-entry[data-wide="true"] .uic-sidebar-entry-button {
        flex: 1; min-width: 0; justify-content: flex-start;
      }
      .uic-sidebar-entry[data-wide="false"] .uic-sidebar-entry-button,
      .uic-sidebar-entry-preview { flex: none; width: 36px; padding-inline: 0; }
      .uic-sidebar-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .uic-sidebar-entry button[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); }
      .uic-main-anchor { flex: 1 1 0; min-width: 0; min-height: 0; }
      html[data-platform="darwin"] .uic-main-anchor[data-uic-panel="uic-preview"] { margin-top: var(--dsh-frame-top-clearance, 48px); }
      .uic-main-surface {
        position: fixed; z-index: 15; box-sizing: border-box;
        display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden;
        pointer-events: auto; background: var(--dsw-alias-bg-base, Canvas);
        color: var(--dsw-alias-label-primary, CanvasText); -webkit-app-region: no-drag;
      }
      .uic-main-surface[aria-hidden="true"] { visibility: hidden; pointer-events: none; }
      .uic-main-surface:focus { outline: none; }
      /* Use the project column for drawing while the canvas is in front.
         Leave the host's saved column width and responsive layout alone. */
      body:has(.uic-main-surface[data-uic-wide="true"]:not([aria-hidden="true"]))
        :is([data-slot="sidebar"], [data-side="sidebar"]) { visibility: hidden; pointer-events: none; }
      body:has(.uic-main-surface[data-uic-edge="true"]:not([aria-hidden="true"]))
        [data-shell-leading] { visibility: hidden; pointer-events: none; }
      html[data-platform="darwin"] .uic-main-surface[data-uic-edge="true"] { --uic-canvas-title-inset: 88px; }
      html[data-platform="darwin"][data-fullscreen] .uic-main-surface[data-uic-edge="true"] { --uic-canvas-title-inset: 12px; }
      .uic-canvas-toolbar {
        display: flex; align-items: center; gap: 8px; flex: 0 0 48px; min-width: 0;
        height: 48px; box-sizing: border-box; padding: 0 10px 0 var(--uic-canvas-title-inset, 12px);
        border-bottom: 1px solid var(--dsw-alias-border-l2); container: uic-title / inline-size;
        -webkit-app-region: drag;
      }
      .uic-canvas-toolbar button, .uic-canvas-file { -webkit-app-region: no-drag; }
      .uic-canvas-file {
        display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; max-width: min(44%, 420px);
        margin-inline-end: auto; line-height: 20px; border-radius: var(--dsw-radius-sm);
      }
      .uic-canvas-file > span, .uic-canvas-file > strong {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .uic-canvas-project { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .uic-canvas-file > strong { flex: 0 1 auto; font-size: 13px; font-weight: 500; }
      .uic-canvas-path-divider { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
      .uic-canvas-toolbar > button { flex: none; }
      .uic-canvas-toolbar > button:disabled { cursor: default !important; opacity: .45; }
      .uic-canvas-toolbar :focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, Highlight);
        outline-offset: 1px;
      }
      .uic-canvas-actions { display: flex; align-items: center; gap: 2px; flex: none; }
      .uic-canvas-actions .uic-title-icon { inline-size: 28px; padding-inline: 0; }
      @container uic-title (max-width: 620px) {
        .uic-title-action-text { display: none; }
        .uic-canvas-actions button { inline-size: 28px; padding-inline: 0; }
      }
      @container uic-title (max-width: 380px) {
        .uic-canvas-project, .uic-canvas-path-divider { display: none; }
      }
      .uic-preview-toolbar, .uic-preview-actions {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .uic-preview-toolbar {
        justify-content: space-between; padding: 6px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l3);
      }
      .uic-preview-status { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .uic-project-label { min-width: 0; max-width: min(40vw, 320px); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; font-size: 12px; user-select: text; }
      .uic-export-result { padding: 6px 12px; font-size: 12px; overflow-wrap: anywhere;
        user-select: text; border-bottom: 1px solid var(--dsw-alias-border-l3); }
      .uic-preview-stage { display: flex; flex: 1; min-height: 0; }
      .uic-preview-frame { border: 0; flex: 1; min-width: 0; width: 100%; color-scheme: light; }
      body[data-ds-dark-theme] .uic-preview-frame { color-scheme: dark; }
    `;
    document.head.append(style);
    return () => {
      disposed.abort();
      style.remove();
    };
  }, "UI compiler: styles and request lifetime");

  function mountAnchor(panelId, element) {
    const anchor = {};
    activeAnchor = anchor;
    const measure = () => {
      if (activeAnchor !== anchor || !element.isConnected) return;
      const { left, top, width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const previous = surface.bounds;
      if (surface.panelId === panelId && previous?.left === left && previous.top === top &&
          previous.width === width && previous.height === height) return;
      publish({ panelId, bounds: { left, top, width, height } });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      if (activeAnchor !== anchor) return;
      activeAnchor = undefined;
      publish({ panelId: null });
    };
  }

  function MainPanelAnchor({ panelId, mount }) {
    const anchorRef = useRef(null);
    useLayoutEffect(() => mount(panelId, anchorRef.current), [panelId, mount]);
    return jsx("div", { className: "uic-main-anchor", "data-uic-panel": panelId, ref: anchorRef, "aria-hidden": true });
  }

  function PersistentSurface({ panelId, state, label, workspaceId, ownerId, children }) {
    const element = useRef(null);
    const visible = state.panelId === panelId && state.bounds !== undefined && workspaceId === state.workspace?.workspaceId;
    useLayoutEffect(() => {
      if (visible) element.current?.focus({ preventScroll: true });
    }, [visible]);

    const wide = panelId === canvasId && state.canvasWide;
    const bounds = state.bounds;
    const style = wide && bounds ? { ...bounds, left: 0, width: bounds.left + bounds.width } : bounds;
    return jsx("section", {
      ref: element,
      className: "uic-main-surface",
      "aria-label": label,
      "aria-hidden": visible ? undefined : true,
      "data-uic-main-surface": panelId,
      "data-uic-wide": wide || undefined,
      "data-uic-edge": panelId === canvasId && (wide || bounds?.left < 2) || undefined,
      "data-uic-workspace": workspaceId,
      "data-openpencil-editor-workbench-owner": ownerId,
      tabIndex: -1,
      style: style ?? { inset: 0 },
      children,
    });
  }

  function CanvasSidebarToggle({ state, locale }) {
    const labels = locale === "zh-CN" ? copy.zh : copy.en;
    const sidebarHidden = state.canvasWide || state.bounds?.left < 2;
    const label = sidebarHidden ? labels.showProjectBar : labels.widenCanvas;
    function toggle() {
      if (sidebarHidden) {
        const anchor = document.querySelector('.uic-main-anchor[data-uic-panel="uic-canvas"]');
        if (anchor?.closest("[data-sidebar-collapsed]")) ctx.layout.toggleSidebar();
      }
      publish({ canvasWide: !sidebarHidden });
    }
    return jsx(Tooltip, {
      label, side: "bottom",
      children: jsx(Button, {
        type: "button", variant: "ghost", size: "sm", "aria-label": label,
        onClick: toggle, children: jsx(IconPanelLeftOutlineRegular, { size: 16, "aria-hidden": true }),
      }),
    });
  }

  function showChat() {
    ctx.layout.selectPanel(null);
  }

  async function openCanvas() {
    const workspace = syncWorkspace();
    if (!workspace) return "projectRequired";
    const { workspaceId } = workspace;
    const canvasSession = "uic-sidebar-" + workspaceId;
    const workbench = getEditorWorkbenchHost();
    if (!workbench || disposed.signal.aborted) return "unavailable";
    if (workbench.isOpen(canvasSession)) {
      ctx.layout.selectPanel(canvasId);
      return;
    }
    const navigation = ctx.layout.beginNavigation();
    const signal = AbortSignal.any([disposed.signal, workspaceLifetime.signal, navigation]);
    const isCurrent = () => !signal.aborted && selectedWorkspace()?.workspaceId === workspaceId;
    try {
      const response = await projectRequest("open", workspaceId, signal, 12000);
      if (!isCurrent()) return;
      if (response.status === 404) return "missing";
      if (!response.ok) return "unavailable";
      const { turns = [], historyUnavailable, workspaceId: responseId, ownerSessionId, projectTitle, ...envelope } = await response.json();
      if (!isCurrent()) return;
      if (responseId !== workspaceId || ownerSessionId !== canvasSession) return "unavailable";
      const grant = presentationGrantOfMeta({ [PRESENTATION_META_KEY]: envelope });
      if (!grant?.document || !grant.editor) return "unavailable";
      const project = projectState(workspaceId);
      project.sourcePath = grant.document.path;
      const opened = workbench.isOpen(canvasSession) || await workbench.open({
        grant, workspaceId, isCurrent,
        sessionId: canvasSession,
        surface: props => jsx(CompilerCanvasSurface, { ...props, workspaceId, projectTitle, project, turns, historyUnavailable }, workspaceId),
      });
      if (!isCurrent()) return;
      if (!opened) return "busy";
      ctx.layout.selectPanel(canvasId);
    } catch {
      if (isCurrent()) return "unavailable";
    }
  }

  function projectRequest(action, workspaceId, signal, timeout = 120000) {
    return fetch(route + "/" + action, {
      method: "POST", credentials: "same-origin", headers: { "X-UIC-Workspace": workspaceId },
      signal: AbortSignal.any([disposed.signal, workspaceLifetime.signal, signal, AbortSignal.timeout(timeout)]),
    });
  }

  async function refreshPreview() {
    const workspace = syncWorkspace();
    if (!workspace) return "projectRequired";
    const { workspaceId } = workspace;
    previewRequest?.abort();
    const request = new AbortController();
    previewRequest = request;
    publish({ previewStatus: "loading" });
    try {
      const response = await projectRequest("preview", workspaceId, request.signal);
      if (!response.ok) throw new Error("Preview request failed");
      const { html, inputHash, workspaceId: responseId } = await response.json();
      if (responseId !== workspaceId || typeof html !== "string" || !html || !/^[0-9a-f]{64}$/.test(inputHash)) {
        throw new Error("Invalid preview response");
      }
      if (request.signal.aborted || disposed.signal.aborted || selectedWorkspace()?.workspaceId !== workspaceId) return;
      const same = surface.preview?.inputHash === inputHash;
      if (!same) exportRequest?.abort();
      publish({
        preview: same ? surface.preview : { html, inputHash },
        previewStatus: "ready",
        ...(same ? {} : { exportStatus: undefined, entryPath: undefined }),
      });
    } catch {
      if (!request.signal.aborted && !disposed.signal.aborted && selectedWorkspace()?.workspaceId === workspaceId) publish({ previewStatus: "error" });
    } finally {
      if (previewRequest === request) previewRequest = undefined;
    }
  }

  function showPreview() {
    if (!syncWorkspace()) return "projectRequired";
    ctx.layout.selectPanel(previewId);
    void refreshPreview();
  }

  async function exportFrontend() {
    const workspace = syncWorkspace();
    if (!workspace || surface.previewStatus !== "ready" || (exportRequest && !exportRequest.signal.aborted)) return;
    const { workspaceId } = workspace;
    const inputHash = surface.preview.inputHash;
    const request = new AbortController();
    exportRequest = request;
    const isCurrent = () => !request.signal.aborted && !disposed.signal.aborted && selectedWorkspace()?.workspaceId === workspaceId;
    publish({ exportStatus: "exporting", entryPath: undefined });
    try {
      const response = await projectRequest("export", workspaceId, request.signal);
      const result = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) {
        const code = result.error;
        publish({ exportStatus: code === "export_conflict" ? "exportConflict" : code === "canvas_changed" ? "exportChanged" : "exportFailed" });
      } else if (result.workspaceId !== workspaceId || result.entryPath !== "design/generated/" + result.inputHash + "/UiPage.tsx") {
        publish({ exportStatus: "exportFailed" });
      } else if (result.inputHash !== inputHash) {
        publish({ exportStatus: "exportChanged" });
      } else {
        publish({ exportStatus: "exportReady", entryPath: result.entryPath });
      }
    } catch {
      if (isCurrent()) publish({ exportStatus: "exportFailed" });
    } finally {
      if (exportRequest === request) exportRequest = undefined;
    }
  }

  function CanvasTitleAction({ icon: Icon, label, onClick, disabled, iconOnly }) {
    return jsx(Tooltip, {
      label, side: "bottom", portal: true,
      children: jsx(Button, {
        type: "button", variant: "ghost", size: "sm", disabled, onClick,
        "aria-label": label, className: iconOnly ? "uic-title-icon" : undefined,
        icon: jsx(Icon, { size: 16, "aria-hidden": true }),
        children: !iconOnly && jsx("span", { className: "uic-title-action-text", children: label }),
      }),
    });
  }

  function CompilerCanvasSurface({
    grant, colorScheme, locale, sessionId, ownerId, onLifecycleState, onLifecycleController, onClose, allowEditorTakeover,
    workspaceId, projectTitle, project, turns, historyUnavailable,
  }) {
    const state = useSyncExternalStore(surfaces.subscribe, surfaces.getSnapshot, surfaces.getSnapshot);
    const labels = locale === "zh-CN" ? copy.zh : copy.en;
    const controller = useRef();
    const current = useRef(INITIAL_EDITOR_LIFECYCLE_STATE);
    const [closing, setClosing] = useState(false);
    const [lifecycle, setLifecycle] = useState(INITIAL_EDITOR_LIFECYCLE_STATE);
    const [closeError, setCloseError] = useState(false);
    const [historyNotice, setHistoryNotice] = useState(historyUnavailable ? "historyReadFailed" : null);

    function formatReply({ reply, change }) {
      const receipt = change ? (change.revised ? labels.revised : labels.added) + " · " + change.name : "";
      return [reply, receipt].filter(Boolean).join("\n\n");
    }

    async function generate({ prompt, selection, signal }) {
      if (selectedWorkspace()?.workspaceId !== workspaceId) throw new Error(labels.projectRequired);
      const agent = getCanvasAgent();
      if (!agent) throw new Error(labels.agentOffline);
      const result = selection.model || selection.reasoningEffort
        ? await agent.generateWithOptions(workspaceId, prompt, selection, signal)
        : await agent.generate(workspaceId, prompt, signal);
      if (!result.ok) throw new Error(labels.agentOffline);
      const data = result.value;
      if (data?.error) {
        if (data.error === "model_unavailable" || data.error === "unsupported_effort") {
          publish({ modelCatalogVersion: (surface.modelCatalogVersion || 0) + 1 });
        }
        const label = data.error === "busy" ? "busyAgent" : data.error;
        throw new Error([labels[label] || labels.agentOffline, data.diagnostic].filter(Boolean).join(" · "));
      }
      if (!data?.reply) throw new Error(labels.agentOffline);
      if (data.historySaved === false) setHistoryNotice("historyWriteFailed");
      return { message: formatReply(data) };
    }

    async function closeCanvas() {
      if (closing || current.current.phase === "saving") return;
      if (!confirmEditorClose(current.current.dirty, () => window.confirm(editorModalCopy(locale).discard))) return;
      setClosing(true);
      setCloseError(false);
      try {
        if (controller.current && !await controller.current.requestClose()) {
          setCloseError(true);
          return;
        }
        onClose();
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === canvasId && selectedWorkspace()?.workspaceId === workspaceId) showChat();
      } catch {
        setCloseError(true);
      } finally {
        setClosing(false);
      }
    }

    const title = (state.workspace?.workspaceId === workspaceId ? workspaceTitle(state.workspace) : projectTitle) || workspaceId;
    const bindingLabel = labels.project + " · " + title + " · " + grant.document.path;
    const filename = grant.document.path.split(/[\\/]/).at(-1);
    return jsxs(PersistentSurface, {
      panelId: canvasId,
      workspaceId,
      state,
      label: labels.canvas,
      ownerId,
      children: [jsx(ManagedOpenPencilEditor, {
        grant,
        colorScheme,
        locale,
        sessionId,
        allowTakeover: allowEditorTakeover,
        onTakeoverRequest: () => false,
        onLifecycleState: next => {
          current.current = next;
          setLifecycle(next);
          onLifecycleState(next);
        },
        onLifecycleController: next => {
          controller.current = next;
          onLifecycleController(next);
        },
        workbenchTitle: jsxs(react_jsx_runtime.Fragment, {
          children: [
            jsx(CanvasSidebarToggle, { state, locale }),
            jsx(Tooltip, {
              label: bindingLabel, side: "bottom", align: "start", portal: true,
              children: jsxs("span", {
                className: "uic-canvas-file", role: "group", tabIndex: 0, "aria-label": bindingLabel,
                children: [
                  jsx("span", { className: "uic-canvas-project", children: title }),
                  jsx("span", { className: "uic-canvas-path-divider", "aria-hidden": true, children: "/" }),
                  jsx("strong", { children: filename }),
                ],
              }),
            }),
          ],
        }),
        workbenchActions: jsxs("div", {
          className: "uic-canvas-actions",
          children: [
            jsx(CanvasTitleAction, { icon: IconPlayOutlineRegular, label: labels.preview, onClick: showPreview }),
            jsx(CanvasTitleAction, { icon: IconChevronLeftOutlineRegular, label: labels.chat, onClick: showChat }),
            jsx(CanvasTitleAction, {
              icon: IconCloseOutlineRegular, label: labels.close, iconOnly: true,
              disabled: closing || lifecycle.phase === "saving", onClick: closeCanvas,
            }),
            closeError ? jsx(Toast, { text: labels.closeFailed, onDone: () => setCloseError(false) }) : null,
          ],
        }),
      }, editorWorkbenchEditorKey(grant, sessionId)), jsx(CanvasAgentComposer, {
        locale, disabled: closing || lifecycle.phase !== "ready", onGenerate: generate,
        initialTurns: turns, formatReply, project, workspaceId,
        active: state.panelId === canvasId && state.workspace?.workspaceId === workspaceId,
        loadModels: loadCanvasModels, catalogVersion: state.modelCatalogVersion,
      }, workspaceId), historyNotice ? jsx(Toast, {
        text: labels[historyNotice], onDone: () => setHistoryNotice(null),
      }) : null],
    });
  }

  function PreviewSurface({ useCompilerSurface, t, openCanvas, showChat, refreshPreview, exportFrontend }) {
    const state = useCompilerSurface(snapshot => snapshot);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState();
    if (!state.workspace || (state.preview === undefined && state.previewStatus === "idle")) return null;

    async function showCanvas() {
      if (pending) return;
      setPending(true);
      setError(undefined);
      try {
        setError(await openCanvas());
      } finally {
        setPending(false);
      }
    }

    const status = state.previewStatus === "loading" ? "previewLoading"
      : state.previewStatus === "error" ? "previewFailed" : "previewSaved";
    const { workspaceId } = state.workspace;
    const bindingLabel = [t("project"), workspaceTitle(state.workspace), projects.get(workspaceId)?.sourcePath].filter(Boolean).join(" · ");
    return jsxs(PersistentSurface, {
      panelId: previewId,
      workspaceId,
      state,
      label: t("preview"),
      children: [
        jsxs("div", {
          className: "uic-preview-toolbar",
          children: [
            jsxs("div", {
              className: "uic-preview-actions",
              children: [
                jsx("strong", { children: t("preview") }),
                jsx("span", { className: "uic-project-label", title: bindingLabel, children: bindingLabel }),
                jsx("span", { className: "uic-preview-status", role: "status", children: t(status) }),
                state.previewStatus === "error" ? jsx(Button, {
                  type: "button", variant: "ghost", size: "sm", onClick: refreshPreview, children: t("retry"),
                }) : null,
              ],
            }),
            jsxs("div", {
              className: "uic-preview-actions",
              children: [
                jsx(Button, {
                  type: "button", variant: "outline", size: "sm",
                  disabled: state.previewStatus !== "ready" || state.exportStatus === "exporting",
                  onClick: exportFrontend, children: t(state.exportStatus === "exporting" ? "exporting" : "export"),
                }),
                jsx(Button, {
                  type: "button", variant: "ghost", size: "sm", disabled: pending,
                  onClick: showCanvas, children: t(pending ? "opening" : "canvas"),
                }),
                jsx(Button, { type: "button", variant: "ghost", size: "sm", onClick: showChat, children: t("chat") }),
              ],
            }),
          ],
        }),
        state.exportStatus && state.exportStatus !== "exporting" ? jsxs("div", {
          className: "uic-export-result", role: "status",
          children: [
            t(state.exportStatus),
            state.entryPath ? jsx("code", { children: " · " + state.entryPath }) : null,
            state.exportStatus === "exportChanged" ? jsx(Button, {
              type: "button", variant: "ghost", size: "sm", onClick: refreshPreview, children: t("retry"),
            }) : null,
          ],
        }) : null,
        jsx("div", {
          className: "uic-preview-stage",
          children: state.preview === undefined ? null : jsx("iframe", {
            className: "uic-preview-frame",
            title: t("preview"),
            sandbox: "allow-scripts",
            referrerPolicy: "no-referrer",
            srcDoc: state.preview.html,
          }),
        }),
        error ? jsx(Toast, { text: t(error), onDone: () => setError(undefined) }) : null,
      ],
    });
  }

  function CompilerSidebarButton({ wide, t, openCanvas, showPreview, usePanelInfo }) {
    const activePanelId = usePanelInfo(info => info.activePanelId);
    const inFlight = useRef(false);
    const sequence = useRef(0);
    const [pending, setPending] = useState(false);
    const [notice, setNotice] = useState();

    async function handleClick() {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setNotice(undefined);
      try {
        const error = await openCanvas();
        if (error) setNotice({ error, id: ++sequence.current });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    }

    const label = t(pending ? "opening" : "title");
    const icon = jsx(IconEditOutlineRegular, { size: 16, "aria-hidden": true });
    return jsxs("div", {
      className: "uic-sidebar-entry",
      "data-wide": String(wide),
      children: [
        jsx(Tooltip, {
          label,
          side: "right",
          onlyWhenClipped: wide,
          children: jsx(Button, {
            type: "button",
            variant: "ghost",
            size: "md",
            className: "uic-sidebar-entry-button",
            "aria-label": label,
            "aria-pressed": activePanelId === canvasId,
            "aria-busy": pending,
            disabled: pending,
            onClick: handleClick,
            icon: wide ? icon : undefined,
            children: wide ? jsx("span", { className: "uic-sidebar-entry-label", children: label }) : icon,
          }),
        }),
        jsx(Tooltip, {
          label: t("preview"),
          side: "right",
          children: jsx(Button, {
            type: "button",
            variant: "ghost",
            size: "md",
            className: "uic-sidebar-entry-preview",
            "aria-label": t("preview"),
            "aria-pressed": activePanelId === previewId,
            onClick: () => {
              const error = showPreview();
              if (error) setNotice({ error, id: ++sequence.current });
            },
            children: jsx(IconCodeOutlineRegular, { size: 16, "aria-hidden": true }),
          }),
        }),
        notice === undefined ? null : jsx(Toast, {
          text: t(notice.error),
          onDone: () => { setNotice(undefined); },
        }, notice.id),
      ],
    });
  }

  for (const panelId of [canvasId, previewId]) {
    ctx.slots.inject("main", () => ctx.slots.register({
      name: "main",
      key: panelId,
      inject: () => ({ panelId, mount: mountAnchor }),
    }, MainPanelAnchor));
  }
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: previewId,
    locale: namespace,
    inject: () => ({ hooks: { compilerSurface: surfaces }, openCanvas, showChat, refreshPreview, exportFrontend }),
  }, PreviewSurface));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "uic-open-canvas",
    locale: namespace,
    inject: () => ({ openCanvas, showPreview }),
  }, CompilerSidebarButton));
}
