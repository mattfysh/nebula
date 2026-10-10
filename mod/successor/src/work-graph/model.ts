export type NodeId = string
export type Name = string

export type Node = {
  id: NodeId
  plugin: string
  data: unknown
  content: NodeId[]
}

export type Graph = {
  nodes: Map<NodeId, Node>
  names: Map<Name, NodeId>
}

/** A plugin may disclose IDs hidden in private data. It does not classify the relationship. */
export type ExtractedReference = { target: NodeId; path: string }
export type ReferenceExtractor = (node: Node) => readonly ExtractedReference[]
export type Extractors = ReadonlyMap<string, ReferenceExtractor>

export type ReferenceEvidence = {
  source: NodeId
  target: NodeId
  provenance: { kind: 'content'; index: number } | { kind: 'plugin-data'; plugin: string; path: string }
}

export type IntegrityIssue =
  | { kind: 'node-key-mismatch'; key: NodeId; id: NodeId }
  | { kind: 'missing-reference'; source: NodeId; target: NodeId; provenance: ReferenceEvidence['provenance'] }
  | { kind: 'missing-name-target'; name: Name; target: NodeId }

export function references(graph: Graph, extractors: Extractors = new Map()): ReferenceEvidence[] {
  const result: ReferenceEvidence[] = []
  for (const node of graph.nodes.values()) {
    node.content.forEach((target, index) => result.push({ source: node.id, target, provenance: { kind: 'content', index } }))
    for (const ref of extractors.get(node.plugin)?.(node) ?? []) {
      result.push({ source: node.id, target: ref.target, provenance: { kind: 'plugin-data', plugin: node.plugin, path: ref.path } })
    }
  }
  return result
}

export function checkIntegrity(graph: Graph, extractors: Extractors = new Map()): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  for (const [key, node] of graph.nodes) if (key !== node.id) issues.push({ kind: 'node-key-mismatch', key, id: node.id })
  for (const ref of references(graph, extractors)) if (!graph.nodes.has(ref.target)) {
    issues.push({ kind: 'missing-reference', source: ref.source, target: ref.target, provenance: ref.provenance })
  }
  for (const [name, target] of graph.names) if (!graph.nodes.has(target)) issues.push({ kind: 'missing-name-target', name, target })
  return issues
}

export function resolveName(graph: Graph, name: Name): Node | undefined {
  const id = graph.names.get(name)
  return id === undefined ? undefined : graph.nodes.get(id)
}
