import { references, type Extractors, type Graph, type NodeId, type ReferenceEvidence } from './model.ts'

export type IndexedEdge = { a: NodeId; b: NodeId; evidence: ReferenceEvidence[] }
export type Neighbor = { node: NodeId; edge: IndexedEdge }
export type GraphIndex = {
  outgoing: Map<NodeId, ReferenceEvidence[]>
  backlinks: Map<NodeId, ReferenceEvidence[]>
  adjacent: Map<NodeId, Neighbor[]>
  degree(id: NodeId): number
}

const add = <T>(map: Map<NodeId, T[]>, id: NodeId, value: T) => {
  const values = map.get(id) ?? []
  values.push(value)
  map.set(id, values)
}

export function indexGraph(graph: Graph, extractors: Extractors = new Map()): GraphIndex {
  const outgoing = new Map<NodeId, ReferenceEvidence[]>(), backlinks = new Map<NodeId, ReferenceEvidence[]>()
  const edgeMap = new Map<string, IndexedEdge>()
  for (const ref of references(graph, extractors)) {
    if (!graph.nodes.has(ref.target)) continue
    add(outgoing, ref.source, ref); add(backlinks, ref.target, ref)
    // Traversal is undirected, while every piece of evidence retains reference direction.
    const [a, b] = ref.source < ref.target ? [ref.source, ref.target] : [ref.target, ref.source]
    const key = `${a}\0${b}`
    const edge = edgeMap.get(key) ?? { a, b, evidence: [] }
    edge.evidence.push(ref); edgeMap.set(key, edge)
  }
  const adjacent = new Map<NodeId, Neighbor[]>()
  for (const edge of edgeMap.values()) {
    add(adjacent, edge.a, { node: edge.b, edge })
    if (edge.a !== edge.b) add(adjacent, edge.b, { node: edge.a, edge })
  }
  return { outgoing, backlinks, adjacent, degree: (id) => adjacent.get(id)?.length ?? 0 }
}
