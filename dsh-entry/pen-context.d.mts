type DesignNode = Record<string, unknown>
interface BoardSummary {
  number: number
  name?: string
  type?: string
  width?: string | number
  height?: string | number
  layers: number
}
interface LayerSummary {
  at: string
  type?: string
  name?: string
  text?: string
  component?: string
}
export interface PenStructure {
  topLevelCount: number
  totalLayers: number
  layerTypes: Record<string, number>
  omittedFromIndex: number
  index: BoardSummary[]
  detail: { board: number; omittedLayers: number; layers: LayerSummary[] }[]
}
export function describePenStructure(children: DesignNode[], query: string, selectedIds?: string[], byteBudget?: number): PenStructure
export function describeCanvasSelection(children: DesignNode[], selectedIds: string[]): (Omit<BoardSummary, 'number' | 'layers'> & { text?: string })[]
export function describeImportedPage(children: DesignNode[], selectedIds: string[], query: string): PenStructure | undefined
export function summarizeImportedNode(node: DesignNode): Omit<BoardSummary, 'number' | 'layers'>
export function describePenVariables(variables: Record<string, unknown>): {
  count: number
  values: { name?: string; type: string; value?: string | number | boolean }[]
}
