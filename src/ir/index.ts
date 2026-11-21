export const designStates = ['default', 'loading', 'empty', 'error'] as const
export type DesignState = typeof designStates[number]

export type DesignWarning = { id: string; name: string; message: string }

type NodeBase = {
  id: string
  name: string
  style: Record<string, unknown>
}

export type DesignNode = NodeBase & (
  | { kind: 'stack'; layout: Record<string, unknown>; children: DesignNode[]; repeat?: string }
  | { kind: 'text'; text: string; binding?: string }
  | { kind: 'instance'; component: string; variants: Record<string, string | boolean | number>; text: Record<string, string> }
  | { kind: 'asset'; asset: 'icon' | 'image'; ref: string }
  | { kind: 'unmapped'; reason: string }
)

export type DesignFrame = { state: DesignState; node: DesignNode }

export type DesignPage = {
  frames: DesignFrame[]
  variables: Record<string, unknown>
  warnings: DesignWarning[]
}
