/** Types for the canvas agent's model request. */
export interface GeneratedCanvasDesign {
  reply: string
  action?: 'create' | 'revise'
  frame?: unknown
  toolCalls?: ReadonlyArray<{name: string; status: 'success' | 'error'; target?: string; summary?: string}>
}

export function generateCanvasDesign(input: {
  llm: unknown
  agentDefaultModel?: unknown
  modelSelection?: { provider: string; model: string; reasoningEffort?: string }
  prompt: string
  history?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>
  context?: Record<string, unknown>
  signal?: AbortSignal
  sessionId?: string
  attachments?: ReadonlyArray<Record<string, unknown>>
  attachmentStore?: unknown
  requireFrame?: boolean
  planCount?: number
  canvasTools?: {specs: ReadonlyArray<unknown>; execute: (name: string, args: unknown) => Promise<unknown>; protocol: unknown; receipts: unknown[]; onReceipt?: (receipt: unknown) => void}
  validateFrame?: (frame: unknown) => unknown
}): Promise<GeneratedCanvasDesign>

export function resolveCanvasAttachments(
  binding: { workspaceRoot: string; assetDir: string },
  attachments: ReadonlyArray<{ id: string }>, prompt: string, previousPenIds: string[],
): Promise<{ manifest: Record<string, unknown>[]; penAssetIds: string[]; resolve: (id: string) => string | undefined } | undefined>
