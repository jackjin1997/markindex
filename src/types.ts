export type NodeKind = 'preface' | 'section' | 'chunk'

export interface TreeNode {
  nodeId: string
  title: string
  kind: NodeKind
  level: number
  startLine: number
  endLine: number
  ownEndLine: number
  tokens: number
  ownTokens: number
  summary?: string
  prefixSummary?: string
  keyItems?: string[]
  children: TreeNode[]
}

export interface DocumentRecord {
  docId: string
  path: string
  title: string
  description?: string
  metadata: Record<string, unknown>
  contentHash: string
  lineCount: number
  tokens: number
  indexedAt: string
}
