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
  const inputs = [
    { name: "workspaceId", wire: "workspaceId", source: "json",
      codec: { mode: "strict", typeSymbol: pkg + "#WorkspaceId", create: () => workspaceSchema } },
    { name: "prompt", wire: "prompt", source: "json",
      codec: { mode: "strict", typeSymbol: pkg + "#CanvasPrompt", create: () => promptSchema } },
  ];
  const selection = { name: "selection", wire: "selection", source: "json",
    codec: { mode: "strict", typeSymbol: pkg + "#CanvasModelSelection", create: () => selectionSchema } };
  const descriptor = (method, parameters) => ({
    id: pkg + "#" + service + "/" + method, service, namespace: service, method,
    invocation: { kind: "direct" }, parameters,
    cancellation: { parameter: "signal" }, result: { mode: "src-json" },
  });
  return {
    package: pkg,
    descriptors: [descriptor("generate", inputs), descriptor("generateWithOptions", [...inputs, selection])],
  };
}
