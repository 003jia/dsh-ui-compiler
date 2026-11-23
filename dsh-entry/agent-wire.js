// Shared by the packaged host and its resident desktop client.
function canvasAgentContribution() {
  const pkg = "@zseven-w/dsh-openpencil";
  const service = "uiCompilerCanvasAgent";
  const workspaceSchema = {
    parse(value) {
      if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid workspace ID");
      return value;
    },
  };
  const promptSchema = {
    parse(value) {
      if (typeof value !== "string" || !value.trim() || value.length > 8000) {
        throw new Error("Invalid canvas design request");
      }
      return value.trim();
    },
  };
  const selectionSchema = {
    parse(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value) ||
          Object.entries(value).some(([key, id]) => !["provider", "model", "reasoningEffort"].includes(key) ||
            typeof id !== "string" || !id.trim()) ||
          Object.hasOwn(value, "provider") !== Object.hasOwn(value, "model")) {
        throw new Error("Invalid canvas model selection");
      }
      return { ...value };
    },
  };
  const attachmentSchema = {
    parse(value) {
      if (!Array.isArray(value) || value.length > 6) throw new Error("Invalid canvas attachments");
      return value.map(item => {
        if (item === null || typeof item !== "object" || Array.isArray(item) ||
            typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) ||
            typeof item.name !== "string" || item.name.length === 0 || item.name.length > 200 ||
            typeof item.mimeType !== "string" || item.mimeType.length > 120) {
          throw new Error("Invalid canvas attachment");
        }
        return { id: item.id, name: item.name, mimeType: item.mimeType };
      });
    },
  };
  const inputs = [
    { name: "workspaceId", wire: "workspaceId", source: "json",
      codec: { mode: "strict", typeSymbol: pkg + "#WorkspaceId", create: () => workspaceSchema } },
    { name: "prompt", wire: "prompt", source: "json",
      codec: { mode: "strict", typeSymbol: pkg + "#CanvasPrompt", create: () => promptSchema } },
    { name: "attachments", wire: "attachments", source: "json",
      codec: { mode: "strict", typeSymbol: pkg + "#CanvasAttachments", create: () => attachmentSchema } },
  ];
  const selection = { name: "selection", wire: "selection", source: "json",
    codec: { mode: "strict", typeSymbol: pkg + "#CanvasModelSelection", create: () => selectionSchema } };
  const visualSelection = {
    name: "visualSelection", wire: "visualSelection", source: "json",
    codec: { mode: "strict", typeSymbol: pkg + "#CanvasVisualSelection", create: () => ({
      parse(value) {
        const boundedId = id => typeof id === "string" && id.length > 0 && id.length <= 512;
        if (!value || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) ||
            (value.activePageId !== null && !boundedId(value.activePageId)) ||
            !Array.isArray(value.selectedIds) || value.selectedIds.length > 256 || !value.selectedIds.every(boundedId)) {
          throw new Error("Invalid visual selection");
        }
        return { sessionId: value.sessionId, activePageId: value.activePageId, selectedIds: [...new Set(value.selectedIds)] };
      },
    }) },
  };
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const plan = { name: "plan", wire: "plan", source: "json",
    codec: { mode: "strict", typeSymbol: pkg + "#CanvasParallelPlan", create: () => ({
      parse(value) {
        if (!value || Object.keys(value).some(k => !["mode", "focus", "count", "iterations", "models", "requestId"].includes(k)) ||
            !Number.isInteger(value.count) || value.count < 1 || value.count > 6 || !Number.isInteger(value.iterations) ||
            value.iterations < 0 || value.iterations > 5 || !["collaborate", "variants"].includes(value.mode) ||
            !["layout", "style", "creative"].includes(value.focus) || !uuid(value.requestId)) throw new Error("Invalid canvas parallel plan");
        const models = value.models ?? [];
        if (!Array.isArray(models) || (models.length && models.length !== value.count) ||
            models.some(m => m !== null && (value.mode !== "variants" || !m?.provider || !m.model ||
              Object.keys(m).some(k => !["provider", "model"].includes(k))))) throw new Error("Invalid per-agent model");
        return { requestId: value.requestId, count: value.count, mode: value.mode, focus: value.focus,
          iterations: value.iterations, models: models.map(m => m && selectionSchema.parse(m)) };
      },
    }) },
  };
  const optionalVisual = { ...visualSelection, codec: { ...visualSelection.codec, typeSymbol: pkg + "#OptionalCanvasVisualSelection",
    create: () => ({ parse: value => value === null ? null : visualSelection.codec.create().parse(value) }) } };
  const requestId = { name: "requestId", wire: "requestId", source: "json", codec: { mode: "strict",
    typeSymbol: pkg + "#CanvasParallelRequestId", create: () => ({ parse(value) {
      if (!uuid(value)) throw new Error("Invalid canvas request ID"); return value;
    } }) } };
  const descriptor = (method, parameters) => ({
    id: pkg + "#" + service + "/" + method, service, namespace: service, method,
    invocation: { kind: "direct" }, parameters,
    cancellation: { parameter: "signal" }, result: { mode: "src-json" },
  });
  return {
    package: pkg,
    descriptors: [
      descriptor("generate", inputs),
      descriptor("generateWithOptions", [inputs[0], inputs[1], selection, inputs[2]]),
      descriptor("generateFromCanvas", [inputs[0], inputs[1], selection, inputs[2], visualSelection]),
      descriptor("generateWithTools", [inputs[0], inputs[1], selection, inputs[2], optionalVisual, requestId]),
      descriptor("generateParallel", [inputs[0], inputs[1], selection, inputs[2], optionalVisual, plan]),
      descriptor("parallelProgress", [inputs[0], requestId]),
      descriptor("appendInstruction", [inputs[0], requestId,
        { ...requestId, name: "additionId", wire: "additionId" }, inputs[1]]),
    ],
  };
}
