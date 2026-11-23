/** Public surface shared by the canvas agent, DSH tool registry and local callers. */
export const iconNames: readonly string[]
export type CanvasToolName = 'uic_canvas_read' | 'uic_canvas_edit'
export const canvasToolSpecs: ReadonlyArray<{
  name: CanvasToolName
  description: string
  inputSchema: Record<string, unknown>
}>
export interface CanvasToolOptions {
  sourcePath?: string
  ownerSessionId?: string
  signal?: AbortSignal
  sessionId?: string
  activePageId?: string | null
  visualSelection?: { sessionId: string; activePageId: string | null; selectedIds: readonly string[] } | null
  allowIconReplacement?: boolean
  allowDelete?: boolean
  scopeRootId?: string
}
interface ToolSession {
  id: string
  read(signal?: AbortSignal): Promise<{ version: number; documentJson: string }>
  selection(): Promise<{ activePageId: string; selectedIds?: readonly string[] }>
  replaceDocument(documentJson: string, version: number): Promise<unknown>
}
interface CanvasToolHost {
  withCompilerCanvas<T>(options: CanvasToolOptions, operation: (live: ToolSession) => Promise<T>): Promise<T>
}
interface DocumentIdentity { sessionId: string; pageId: string; version: number }
interface LayerSummary {
  id: string
  name: string
  type: string
  parentId: string | null
  childCount: number
  text?: string
  icon?: string
  fill?: string
  x?: number
  y?: number
  width?: string | number
  height?: string | number
  fontSize?: string | number
  fontWeight?: string | number
  layout?: string
  fontFamily?: string
  lineHeight?: number
  gap?: number
  alignItems?: string
  justifyContent?: string
  textAlign?: string
  padding?: number | number[]
  stroke?: string
  strokeWidth?: number
  cornerRadius?: string | number
  opacity?: number
}
export interface CanvasReadResult extends DocumentIdentity {
  nodes: LayerSummary[]
  selection: LayerSummary[]
  total: number
  nextOffset?: number
}
export interface CanvasEditResult extends DocumentIdentity {
  changed: Array<Partial<LayerSummary> & { id: string; name?: string; op: 'add' | 'remove' | 'update'; nextSiblingId?: string }>
}
export function canvasIconReplacementRequested(prompt: unknown): boolean
export function canvasDeletionRequested(prompt: unknown): boolean
export function runCanvasTool<N extends string>(host: CanvasToolHost, options: CanvasToolOptions, name: N, args: unknown):
  Promise<N extends 'uic_canvas_read' ? CanvasReadResult : N extends 'uic_canvas_edit' ? CanvasEditResult : CanvasReadResult | CanvasEditResult>
