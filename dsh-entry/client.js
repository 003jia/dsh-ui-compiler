// Ask the currently mounted OpenPencil frame for its visual selection. Its
// daemon can temporarily lose this information while replacing the document.
function readCompilerVisualSelection(frame, origin, sessionId, signal) {
  if (!frame || !origin || !sessionId || signal?.aborted) return Promise.resolve(null);
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", cancel);
      resolve(value);
    };
    const receive = event => {
      if (event.source !== frame || event.origin !== origin) return;
      const data = event.data;
      if (data?.type !== "uic/selection-result" || data.requestId !== requestId) return;
      if (!Array.isArray(data.selectedIds)) return finish(null);
      finish({ sessionId, activePageId: data.activePageId, selectedIds: data.selectedIds });
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 1600);
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", cancel, { once: true });
    try { frame.postMessage({ type: "uic/selection-request", requestId }, origin); }
    catch { finish(null); }
  });
}

/** Persistent compiler surfaces in the official DSH main panel. */
function mountCompilerSidebarAction(ctx, getEditorWorkbenchHost, getCanvasAgent) {
  const {
    Button, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconCodeOutlineRegular,
    IconEditOutlineRegular, IconFolderOpenOutlineRegular, IconPlayOutlineRegular, Toast, Tooltip,
  } = require("@deepseek-ai/dsh-client-ui-primitives");
  const { IconPanelLeftOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
  const { jsx, jsxs } = react_jsx_runtime;
  const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = react;
  const namespace = "uic-sidebar-entry";
  const canvasId = "uic-canvas";
  const previewId = "uic-preview";
  const route = "/_dsh/dsh-openpencil/ui-compiler";
  const disposed = new AbortController();
  const copy = {
    zh: {
      importPen: "导入 .pen", importingPen: "正在导入…", penImages: "选择稿件配图",
      penImageHint: "选择稿件引用的图片，配齐后会自动导入画板。", penImageMismatch: "请选择路径末尾同名的图片。",
      invalid_pen: "无法解析此 .pen，请选择 Pencil 导出的设计文件。", penFailed: "导入失败，请检查稿件后重试。",
      penAlready: "这份稿件已经在画布中。", penResult: (boards, layers) => `已导入 ${boards} 个画板，共 ${layers} 个图层。`,
      penWarnings: "导入提示", pen_id_conflict: "导入稿件与已有图层的标识冲突。", too_large: "稿件或配图超过导入大小限制。", unsupported_image: "请选择 PNG、JPEG、WebP 或 GIF 图片。", penWrongPage: "画布内容已变化，请重新导入。",
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
      image_attachment_failed: "图片读取失败，请用「＋」重新添加 PNG、JPEG、WebP 或 GIF 图片后再发送。",
      invalid_request: "请输入 8000 字以内的设计需求。",
      partial_base: "这次任务已写入部分改动。请核对工具记录，再发送剩余的修改要求。",
      partial_followup: "本轮有追加要求未完成。请查看各条状态，已执行过的操作会保留。",
      parallel_edit_targets: "原位编辑时，每位 Agent 需要一张已有画板。请按画板数量选择人数，使用分工协作，并关闭变体。",
      invalid_design: "模型返回的图层无法绘制，请重试或补充需求。",
      busyAgent: "上一条画布需求仍在处理中。",
      canvas_changed: "画布内容已变化，请核对后再发送。",
      canvas_unavailable: "请等画布加载完成后再发送。",
      revision_conflict: "这张画板有新的手动修改，请说明要保留的内容后再试。",
      edit_failed: "写入图层失败，请核对当前画布后再试。",
      historyReadFailed: "画布已打开，暂时无法读取历史对话。",
      historyWriteFailed: "本次操作已完成，但对话未能保存。",
      added: "已添加画板", revised: "已更新画板", dropFiles: "松开以放入画布",
      targetFolder: "目标目录", designFolder: "设计稿目录", assetFolder: "上传资源目录",
      folderHint: "相对项目根目录，例如 design/pages", save: "保存", cancel: "取消", folderLoading: "正在读取…",
      folderSaved: "目标目录已保存。", folderPending: "目标目录已保存；保存或关闭当前画布后重新打开生效。", folderFailed: "目标目录保存失败，请检查路径。",
      imageInserted: "图片已放入画布。", fileSaved: "文件已保存到项目资源目录。", uploadFailed: "上传失败，请重试。",
    },
    en: {
      importPen: "Import .pen", importingPen: "Importing…", penImages: "Choose linked images",
      penImageHint: "Choose the images referenced in this design to finish importing its boards.", penImageMismatch: "Choose the image with the indicated filename.",
      invalid_pen: "Could not parse this .pen file. Choose a Pencil design document.", penFailed: "Could not import this design. Check the file and try again.",
      penAlready: "This design is already in the canvas.", penResult: (boards, layers) => `Imported ${boards} boards with ${layers} layers in total.`,
      penWarnings: "Import notes", pen_id_conflict: "This design conflicts with existing layer IDs.", too_large: "The design or its images exceed the import size limit.", unsupported_image: "Choose a PNG, JPEG, WebP or GIF image.", penWrongPage: "The canvas changed. Please import again.",
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
      image_attachment_failed: "The image could not be read. Use + to attach a PNG, JPEG, WebP or GIF, then send again.",
      invalid_request: "Enter a design request of up to 8,000 characters.",
      partial_base: "This task applied some edits before it stopped. Review the tool history and send the remaining changes.",
      partial_followup: "Some follow-ups did not finish. Check their individual statuses. Completed edits are preserved.",
      parallel_edit_targets: "Each agent needs an existing board for in-place edits. Choose one agent per board, use collaboration, and turn variations off.",
      invalid_design: "The model returned an unusable design. Retry or refine the request.",
      busyAgent: "The previous canvas request is still running.",
      canvas_changed: "The canvas changed. Review it before retrying.",
      canvas_unavailable: "Wait for the canvas to finish loading before sending.",
      revision_conflict: "This frame has new manual edits. Review them before retrying.",
      edit_failed: "Could not apply the design. Review the canvas before retrying.",
      historyReadFailed: "The canvas is open, but its conversation could not be loaded.",
      historyWriteFailed: "The request completed, but the conversation could not be saved.",
      added: "Added frame", revised: "Updated frame", dropFiles: "Drop to place on the canvas",
      targetFolder: "Target folder", designFolder: "Design folder", assetFolder: "Upload folder",
      folderHint: "Relative to the project root, for example design/pages", save: "Save", cancel: "Cancel", folderLoading: "Loading…",
      folderSaved: "Target folder saved.", folderPending: "Target folder saved. Save or close the current canvas, then reopen it.", folderFailed: "Could not save the target folder. Check the path.",
      imageInserted: "Image placed on the canvas.", fileSaved: "File saved to the project assets.", uploadFailed: "Upload failed. Try again.",
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
      .uic-folder-panel {
        position: absolute; z-index: 6; top: 56px; right: 16px; width: min(340px, calc(100% - 32px));
        box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; padding: 14px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-2, Canvas); color: var(--dsw-alias-label-primary, CanvasText);
        box-shadow: 0 8px 24px rgb(0 0 0 / 14%); font: var(--dsw-font-xs-13);
      }
      .uic-pen-resources { max-height: min(40vh, 260px); overflow: auto; display: grid; gap: 4px; overflow-wrap: anywhere; }
      .uic-folder-field { display: flex; flex-direction: column; gap: 4px; }
      .uic-folder-field > span { color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; }
      .uic-folder-field input {
        box-sizing: border-box; width: 100%; min-height: 32px; padding: 0 8px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-base, Canvas); color: inherit; font: inherit;
      }
      .uic-folder-hint { margin: 0; color: var(--dsw-alias-label-tertiary, GrayText); font-size: 12px; }
      .uic-folder-error { margin: 0; color: var(--dsw-alias-state-error-primary, CanvasText); font-size: 12px; }
      .uic-folder-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .uic-canvas-drop {
        position: absolute; z-index: 7; inset: 0; display: flex; align-items: center; justify-content: center;
        border: 2px dashed var(--dsw-focus-ring-color, Highlight); border-radius: var(--dsw-radius-md);
        background: color-mix(in srgb, var(--dsw-alias-bg-base, Canvas) 82%, transparent);
        color: var(--dsw-alias-label-primary, CanvasText); font: var(--dsw-font-xs-13); pointer-events: auto;
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

  function PersistentSurface({ panelId, state, label, workspaceId, ownerId, children, onDragOver, onDrop, dropActive, dropLabel }) {
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
      onDragOver,
      onDrop,
      children: dropActive ? [children, jsx("div", {
        className: "uic-canvas-drop", "aria-hidden": true, children: dropLabel,
      })] : children,
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
      const { turns = [], historyUnavailable, conversationId, conversationTitle, conversations = [],
        workspaceId: responseId, ownerSessionId, projectTitle, ...envelope } = await response.json();
      if (!isCurrent()) return;
      if (responseId !== workspaceId || ownerSessionId !== canvasSession) return "unavailable";
      const grant = presentationGrantOfMeta({ [PRESENTATION_META_KEY]: envelope });
      if (!grant?.document || !grant.editor) return "unavailable";
      const project = projectState(workspaceId);
      project.sourcePath = grant.document.path;
      const opened = workbench.isOpen(canvasSession) || await workbench.open({
        grant, workspaceId, isCurrent,
        sessionId: canvasSession,
        surface: props => jsx(CompilerCanvasSurface, {
          ...props, workspaceId, projectTitle, project, turns, historyUnavailable,
          conversationId, conversationTitle, conversations, reopenCanvas: openCanvas,
        }, workspaceId),
      });
      if (!isCurrent()) return;
      if (!opened) return "busy";
      ctx.layout.selectPanel(canvasId);
    } catch {
      if (isCurrent()) return "unavailable";
    }
  }

  async function uploadProjectFile(workspaceId, file) {
    const response = await fetch(route + "/asset", {
      method: "POST", credentials: "same-origin",
      headers: {
        "X-UIC-Workspace": workspaceId,
        "X-UIC-Filename": encodeURIComponent(file.name),
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    })
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error === "invalid_pen" ? "invalid_pen" : "uploadFailed");
    }
    const asset = await response.json()
    return { id: asset.id, name: asset.name, mimeType: asset.mimeType, bytes: asset.bytes, path: asset.path }
  }

  async function insertUploadedImage(workspaceId, id) {
    const response = await fetch(route + "/image", {
      method: "POST", credentials: "same-origin",
      headers: { "X-UIC-Workspace": workspaceId, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) throw new Error("Image insertion failed")
    return response.json()
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

  function CompilerFolderPanel({ labels, draft, error, onChange, onSave, onCancel }) {
    return jsxs("div", {
      className: "uic-folder-panel", role: "dialog", "aria-label": labels.targetFolder,
      children: [
        jsx("strong", { children: labels.targetFolder }),
        draft === null ? jsx("p", { className: "uic-folder-hint", children: labels.folderLoading }) : jsxs(react_jsx_runtime.Fragment, {
          children: [
            jsxs("label", {
              className: "uic-folder-field",
              children: [
                jsx("span", { children: labels.designFolder }),
                jsx("input", {
                  value: draft.designDir, spellCheck: false,
                  onChange: event => onChange({ ...draft, designDir: event.target.value }),
                }),
              ],
            }),
            jsxs("label", {
              className: "uic-folder-field",
              children: [
                jsx("span", { children: labels.assetFolder }),
                jsx("input", {
                  value: draft.assetDir, spellCheck: false,
                  onChange: event => onChange({ ...draft, assetDir: event.target.value }),
                }),
              ],
            }),
            jsx("p", { className: "uic-folder-hint", children: labels.folderHint }),
            error ? jsx("p", { className: "uic-folder-error", role: "alert", children: labels.folderFailed }) : null,
          ],
        }),
        jsxs("div", {
          className: "uic-folder-actions",
          children: [
            jsx(Button, { type: "button", variant: "ghost", size: "sm", onClick: onCancel, children: labels.cancel }),
            jsx(Button, {
              type: "button", variant: "primary", size: "sm", disabled: draft === null, onClick: onSave,
              children: labels.save,
            }),
          ],
        }),
      ],
    });
  }

  function CompilerCanvasSurface({
    grant, colorScheme, locale, sessionId, ownerId, onLifecycleState, onLifecycleController, onClose, allowEditorTakeover,
    workspaceId, projectTitle, project, turns, historyUnavailable, reopenCanvas,
    conversationId: openedConversationId, conversationTitle, conversations: openedConversations = [],
  }) {
    const state = useSyncExternalStore(surfaces.subscribe, surfaces.getSnapshot, surfaces.getSnapshot);
    const labels = locale === "zh-CN" ? copy.zh : copy.en;
    const lastRequest = useRef(null);
    const controller = useRef();
    const current = useRef(INITIAL_EDITOR_LIFECYCLE_STATE);
    const [closing, setClosing] = useState(false);
    const [lifecycle, setLifecycle] = useState(INITIAL_EDITOR_LIFECYCLE_STATE);
    const [closeError, setCloseError] = useState(false);
    const [historyNotice, setHistoryNotice] = useState(historyUnavailable ? "historyReadFailed" : null);
    const [chat, setChat] = useState(() => ({
      id: openedConversationId ?? null, title: conversationTitle ?? "",
      turns, conversations: openedConversations,
    }));
    const [chatError, setChatError] = useState(false);
    const [folderOpen, setFolderOpen] = useState(false);
    const [folderDraft, setFolderDraft] = useState(null);
    const [folderError, setFolderError] = useState(false);
    const [dropActive, setDropActive] = useState(false);
    const [dropNotice, setDropNotice] = useState(null);
    const [penPending, setPenPending] = useState(null);
    const [penBusy, setPenBusy] = useState(false);
    const [penNotes, setPenNotes] = useState([]);
    const penLock = useRef(false);
    const penPicker = useRef(null);
    const imagePicker = useRef(null);
    const imagePath = useRef(null);

    async function importPen(file, imageFile, path) {
      if (penLock.current || selectedWorkspace()?.workspaceId !== workspaceId) return;
      if (imageFile && (!penPending || imageFile.name !== path?.split("/").pop())) {
        setDropNotice(labels.penImageMismatch);
        return;
      }
      const signal = workspaceLifetime.signal;
      penLock.current = true;
      setPenBusy(true);
      setDropNotice(null);
      setPenNotes([]);
      try {
        let design = penPending;
        if (file) {
          const { id, name } = await uploadProjectFile(workspaceId, file);
          design = { id, name, resources: [] };
        } else if (imageFile) {
          const image = await uploadProjectFile(workspaceId, imageFile);
          design = { ...design, resources: [...design.resources.filter(item => item.path !== path), { path, id: image.id }] };
        } else return;
        const response = await fetch(route + "/import-pen", {
          method: "POST", credentials: "same-origin", signal,
          headers: { "X-UIC-Workspace": workspaceId, "Content-Type": "application/json" },
          body: JSON.stringify({ id: design.id, resources: design.resources }),
        });
        const result = await response.json();
        if (signal.aborted) return;
        if (response.status === 422 && result.error === "pen_resources_required" && result.missing?.length) {
          setPenPending({ ...design, missing: result.missing });
          return true;
        }
        if (!response.ok) throw new Error(result.error);
        setPenPending(null);
        setDropNotice(result.alreadyImported ? labels.penAlready : labels.penResult(result.boardCount, result.layerCount));
        setPenNotes(Array.isArray(result.warnings) ? result.warnings.filter(n => typeof n === "string") : []);
      } catch (error) {
        if (!signal.aborted) setDropNotice(error.message === "canvas_changed" ? labels.penWrongPage :
          typeof labels[error.message] === "string" ? labels[error.message] : labels.penFailed);
      } finally {
        penLock.current = false;
        setPenBusy(false);
      }
    }

    useEffect(() => {
      if (!folderOpen || folderDraft !== null) return;
      const request = new AbortController();
      fetch(route + "/config", {
        method: "GET", credentials: "same-origin", headers: { "X-UIC-Workspace": workspaceId }, signal: request.signal,
      }).then(response => response.ok ? response.json() : Promise.reject())
        .then(config => setFolderDraft({ designDir: config.designDir, assetDir: config.assetDir }))
        .catch(() => { if (!request.signal.aborted) { setFolderDraft({ designDir: "design/pages", assetDir: "design/assets" }); setFolderError(true) } });
      return () => { request.abort() };
    }, [folderOpen, folderDraft, workspaceId]);

    async function switchConversation(action, id) {
      try {
        const response = await fetch(route + "/conversations", {
          method: "POST", credentials: "same-origin",
          headers: { "X-UIC-Workspace": workspaceId, "Content-Type": "application/json" },
          body: JSON.stringify(action === "new" ? { action: "new" } : { action: "select", id }),
        });
        if (!response.ok) throw new Error("conversation");
        const data = await response.json();
        if (data?.conversation?.id === undefined) throw new Error("conversation");
        project.draft = "";
        setChatError(false);
        setChat({
          id: data.conversation.id, title: data.conversation.title ?? "",
          turns: Array.isArray(data.conversation.turns) ? data.conversation.turns : [],
          conversations: Array.isArray(data.conversations) ? data.conversations : [],
        });
      } catch {
        setChatError(true);
      }
    }

    async function saveFolder() {
      if (folderDraft === null) return;
      try {
        const response = await fetch(route + "/config", {
          method: "POST", credentials: "same-origin",
          headers: { "X-UIC-Workspace": workspaceId, "Content-Type": "application/json" },
          body: JSON.stringify(folderDraft),
        });
        if (!response.ok) throw new Error("config");
        const config = await response.json();
        const changed = typeof project.sourcePath !== "string" || !project.sourcePath.endsWith("/" + config.designDir + "/ui.op");
        setFolderOpen(false);
        setFolderDraft(null);
        if (changed && ctx.layout.panelInfo.getSnapshot().activePanelId === canvasId) {
          const closed = await closeCanvas();
          if (closed) setTimeout(() => { void reopenCanvas() }, 0);
          else setDropNotice(labels.folderPending);
        } else {
          setDropNotice(labels.folderSaved);
        }
      } catch {
        setFolderError(true);
      }
    }

    async function handleCanvasDrop(event) {
      event.preventDefault();
      setDropActive(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      let waitingForResources = !!penPending;
      for (const file of files) {
        if (/\.pen$/i.test(file.name)) {
          if (!waitingForResources) waitingForResources = await importPen(file);
          continue;
        }
        try {
          const asset = await uploadProjectFile(workspaceId, file);
          if ((file.type || "").startsWith("image/") && asset.mimeType.startsWith("image/")) {
            await insertUploadedImage(workspaceId, asset.id);
            setDropNotice(labels.imageInserted);
          } else {
            setDropNotice(labels.fileSaved);
          }
        } catch {
          setDropNotice(labels.uploadFailed);
        }
      }
    }

    useEffect(() => {
      const dragenter = event => {
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        if (state.panelId !== canvasId || state.workspace?.workspaceId !== workspaceId) return;
        setDropActive(true);
      };
      const dragover = event => {
        if (state.panelId !== canvasId || state.workspace?.workspaceId !== workspaceId) return;
        if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
      };
      window.addEventListener("dragenter", dragenter);
      window.addEventListener("dragover", dragover);
      return () => {
        window.removeEventListener("dragenter", dragenter);
        window.removeEventListener("dragover", dragover);
      };
    }, [state.panelId, state.workspace?.workspaceId, workspaceId]);

    function formatReply({ reply, change }) {
      const receipt = change ? (change.revised ? labels.revised : labels.added) + " · " + change.name : "";
      return [reply, receipt].filter(Boolean).join("\n\n");
    }

    async function generate({ prompt, selection, attachments = [], signal, plan, onStatus, onProgress, onReady, runLabels }) {
      if (selectedWorkspace()?.workspaceId !== workspaceId) throw new Error(labels.projectRequired);
      const agent = getCanvasAgent();
      if (!agent) throw new Error(labels.agentOffline);
      const visual = await controller.current?.readVisualSelection?.(signal);
      signal?.throwIfAborted();
      if (selectedWorkspace()?.workspaceId !== workspaceId) throw new Error(labels.canvas_changed);
      const target = visual ? [visual.sessionId, visual.activePageId, [...visual.selectedIds].sort()] : [sessionId, null];
      const key = JSON.stringify([chat.id, target, prompt, selection, attachments.map(a => a.id), plan ?? null]);
      if (lastRequest.current?.key !== key) lastRequest.current = { key, requestId: crypto.randomUUID() };
      const requestId = lastRequest.current.requestId;
      onReady?.(async (additionId, text) => {
        signal.throwIfAborted();
        if (selectedWorkspace()?.workspaceId !== workspaceId) throw new Error(labels.canvas_changed);
        const response = await agent.appendInstruction(workspaceId, requestId, additionId, text, signal);
        if (!response.ok) throw new Error(labels.agentOffline);
        if (!response.value?.ok) throw Object.assign(new Error(response.value?.error || "closed"), { code: response.value?.error || "closed" });
        return response.value.status;
      });
      const poll = new AbortController();
      const progressSignal = AbortSignal.any([signal, poll.signal]);
      let timer, latest, fingerprint;
      async function refresh() {
        if (progressSignal.aborted) return;
        try {
          const response = await agent.parallelProgress(workspaceId, requestId, progressSignal);
          const state = response.ok && response.value;
          if (state?.phase && !progressSignal.aborted) {
            const next = JSON.stringify({ ...state, elapsedMs: undefined });
            if (fingerprint !== next) {
              fingerprint = next;
              latest = state;
              onProgress?.(state);
              const status = state.phase === "planning" ? runLabels.planning : state.phase === "writing" ? runLabels.writing
                : state.phase === "followup" ? runLabels.followup
                : plan && state.phase === "generating" ? runLabels.running(state.completed, state.total)
                : state.slots?.some(slot => slot.activeTool?.name === "uic_canvas_read") ? runLabels.reading
                : state.slots?.some(slot => slot.activeTool?.name === "uic_canvas_edit") ? runLabels.editing
                : state.phase === "generating" ? runLabels.generating : null;
              if (status) onStatus(status);
            }
            // The iframe expires stale pointers. Keep an active run present during long model steps.
            if (Array.isArray(state.slots)) controller.current?.updateAgentWork?.({
              requestId, sessionId: state.sessionId, pageId: state.pageId, slots: state.slots,
            });
          }
        } catch { /* A later snapshot includes every completed tool receipt. */ }
        if (!progressSignal.aborted) timer = setTimeout(refresh, 350);
      }
      timer = setTimeout(refresh, 180);
      let result;
      try {
        result = plan
          ? await agent.generateParallel(workspaceId, prompt, selection, attachments, visual ?? null, { ...plan, requestId }, signal)
          : await agent.generateWithTools(workspaceId, prompt, selection, attachments, visual ?? null, requestId, signal);
      } finally {
        poll.abort();
        clearTimeout(timer);
        const finished = result?.ok && !result.value?.error && !signal.aborted;
        const last = (finished && result.value?.plan) || latest;
        const anchor = { requestId, sessionId: last?.sessionId || sessionId, pageId: last?.pageId ?? null };
        if (finished && last?.slots?.length) controller.current?.updateAgentWork?.({ ...anchor, slots: last.slots });
        controller.current?.updateAgentWork?.({ ...anchor, slots: [], ...(finished ? { finished: true } : {}) });
      }
      if (!result.ok) throw new Error(labels.agentOffline);
      const data = result.value;
      if (data?.error) {
        if (data.error === "model_unavailable" || data.error === "unsupported_effort") {
          publish({ modelCatalogVersion: (surface.modelCatalogVersion || 0) + 1 });
        }
        const label = data.error === "busy" ? "busyAgent" : data.error;
        const message = [labels[label] || labels.agentOffline, data.diagnostic].filter(Boolean).join(" · ");
        throw Object.assign(new Error(message), { toolCalls: data.toolCalls, plan: data.plan || latest });
      }
      if (!data?.reply) throw new Error(labels.agentOffline);
      if (lastRequest.current?.requestId === requestId) lastRequest.current = null;
      if (data.historySaved === false) setHistoryNotice("historyWriteFailed");
      return { message: formatReply(data), toolCalls: data.toolCalls, plan: data.plan || latest };
    }

    async function closeCanvas() {
      if (closing || current.current.phase === "saving") return false;
      if (!confirmEditorClose(current.current.dirty, () => window.confirm(editorModalCopy(locale).discard))) return false;
      setClosing(true);
      setCloseError(false);
      try {
        if (controller.current && !await controller.current.requestClose()) {
          setCloseError(true);
          return false;
        }
        onClose();
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === canvasId && selectedWorkspace()?.workspaceId === workspaceId) showChat();
        return true;
      } catch {
        setCloseError(true);
        return false;
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
      onDragOver: event => {
        if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
      },
      onDrop: handleCanvasDrop,
      dropActive,
      dropLabel: labels.dropFiles,
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
            jsx(CanvasTitleAction, {
              icon: IconEditOutlineRegular, label: penBusy ? labels.importingPen : labels.importPen,
              disabled: penBusy || !!penPending || lifecycle.phase !== "ready",
              onClick: () => { setFolderOpen(false); penPicker.current?.click(); },
            }),
            jsx(CanvasTitleAction, {
              disabled: penBusy || !!penPending, icon: IconFolderOpenOutlineRegular, label: labels.targetFolder,
              onClick: () => { setFolderError(false); setFolderDraft(null); setFolderOpen(open => !open); },
            }),
            jsx(CanvasTitleAction, { icon: IconPlayOutlineRegular, label: labels.preview, onClick: showPreview }),
            jsx(CanvasTitleAction, { icon: IconChevronLeftOutlineRegular, label: labels.chat, onClick: showChat }),
            jsx(CanvasTitleAction, {
              icon: IconCloseOutlineRegular, label: labels.close, iconOnly: true,
              disabled: closing || lifecycle.phase === "saving", onClick: closeCanvas,
            }),
            closeError ? jsx(Toast, { text: labels.closeFailed, onDone: () => setCloseError(false) }) : null,
          ],
        }),
      }, editorWorkbenchEditorKey(grant, sessionId)), folderOpen ? jsx(CompilerFolderPanel, {
        labels, draft: folderDraft, error: folderError,
        onChange: setFolderDraft,
        onSave: saveFolder,
        onCancel: () => { setFolderOpen(false); setFolderDraft(null); },
      }) : null, jsx("input", {
        type: "file", accept: ".pen", hidden: true, ref: penPicker,
        onChange: event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importPen(file); },
      }), jsx("input", {
        type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true, ref: imagePicker,
        onChange: event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importPen(null, file, imagePath.current); },
      }), penPending ? jsxs("section", {
        className: "uic-folder-panel", role: "dialog", "aria-label": labels.penImages,
        children: [
          jsx("strong", { children: labels.penImages }), jsx("span", { children: penPending.name }),
          jsx("p", { className: "uic-folder-hint", children: labels.penImageHint }),
          jsx("div", { className: "uic-pen-resources", children: penPending.missing.map(path => jsx(Button, {
            type: "button", size: "sm", disabled: penBusy, children: path,
            onClick: () => { imagePath.current = path; imagePicker.current?.click(); },
          }, path)) }),
          jsx(Button, { type: "button", size: "sm", variant: "ghost", disabled: penBusy, onClick: () => setPenPending(null), children: labels.cancel }),
        ],
      }) : penNotes.length ? jsxs("aside", { className: "uic-folder-panel", children: [
        jsx("strong", { children: labels.penWarnings }),
        jsx("ul", { className: "uic-pen-resources", children: penNotes.map((note, i) => jsx("li", { children: note }, i)) }),
        jsx(Button, { type: "button", size: "sm", variant: "ghost", onClick: () => setPenNotes([]), children: locale === "zh-CN" ? "知道了" : "Dismiss" }),
      ] }) : null, jsx(CanvasAgentComposer, {
        locale, disabled: closing || lifecycle.phase !== "ready", onGenerate: generate,
        initialTurns: chat.turns, formatReply, project, workspaceId,
        active: state.panelId === canvasId && state.workspace?.workspaceId === workspaceId,
        loadModels: loadCanvasModels, catalogVersion: state.modelCatalogVersion,
        uploadFile: file => uploadProjectFile(workspaceId, file),
        conversationId: chat.id, conversations: chat.conversations,
        onNewConversation: () => switchConversation("new"),
        onSelectConversation: id => switchConversation("select", id),
      }, chat.id), chatError ? jsx(Toast, {
        text: labels.conversationFailed, onDone: () => setChatError(false),
      }) : null, historyNotice ? jsx(Toast, {
        text: labels[historyNotice], onDone: () => setHistoryNotice(null),
      }) : null, dropNotice ? jsx(Toast, {
        text: dropNotice, onDone: () => setDropNotice(null),
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
