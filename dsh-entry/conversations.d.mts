/** Types for project canvas conversations. */
export interface CanvasToolReceipt {
  name: 'uic_canvas_read' | 'uic_canvas_edit' | 'uic_canvas_place' | 'uic_update_plan'
  status: 'success' | 'error'
  target?: string
  summary?: string
  agentIndex?: number
  round?: number
  source?: 'editor'
  additionId?: string
}
export function cleanCanvasToolCalls(value: unknown): CanvasToolReceipt[]
type ProgressStatus = 'queued' | 'running' | 'writing' | 'done' | 'failed'
interface VisibleStep { title: string; status: ProgressStatus }
interface RecordedModel { provider: string; model: string }
export interface CanvasTaskPlan {
  phase: 'done' | 'failed'
  total: number
  completed: number
  elapsedMs?: number
  steps: VisibleStep[]
  slots: Array<VisibleStep & {
    index: number
    round: number
    scope: string
    tasks?: VisibleStep[]
    model?: RecordedModel
    modelLabel?: string
    elapsedMs?: number
    toolCalls: CanvasToolReceipt[]
  }>
  additions: Array<{ id: string; text: string; status: ProgressStatus; reply?: string; model?: RecordedModel; elapsedMs?: number }>
}
export interface ConversationTurn {
  plan?: CanvasTaskPlan
  toolCalls?: CanvasToolReceipt[]
  failed?: boolean
  prompt: string
  penAssetIds?: string[]
  batchId?: string
  reply: string
  change?: { name: string; revised: boolean }
}
export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
  turnCount: number
}
export interface Conversation {
  id: string
  title: string
  turns: ConversationTurn[]
}
export interface ConversationList {
  activeId: string
  conversations: ConversationSummary[]
}
export function listConversations(binding: unknown): Promise<ConversationList>
export function activeConversation(binding: unknown): Promise<Conversation>
export function createConversation(binding: unknown): Promise<Conversation & { activeId: string }>
export function selectConversation(binding: unknown, id: string): Promise<Conversation & { activeId: string }>
export function appendConversationTurn(binding: unknown, turn: ConversationTurn, conversationId?: string): Promise<ConversationSummary>
export function readActiveTurns(binding: unknown): Promise<ConversationTurn[]>
export const CONVERSATION_LIMITS: { conversations: number; turns: number; file: number }
