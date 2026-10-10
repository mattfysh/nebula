import type { GraphIndex, IndexedEdge } from './index.ts'
import type { Graph, NodeId, ReferenceEvidence } from './model.ts'

export type TraversalDirection = 'forward' | 'backward'
export type PathStep = {
  from: NodeId
  to: NodeId
  direction: TraversalDirection
  evidence: ReferenceEvidence
  alternatives: ReferenceEvidence[]
  cost: { base: number; provenancePenalty: number }
}
export type CandidatePath = {
  nodes: NodeId[]
  steps: PathStep[]
  score: number
  scoreEvidence: { hops: number; provenancePenalty: number; directionChanges: number; directionChangePenalty: number; hubPenalty: number }
}
export type Ranking = {
  directionChangePenalty?: number
  hubPenalty?: (degree: number) => number
  provenancePenalty?: (evidence: ReferenceEvidence, graph: Graph) => number
}

function oriented(edge: IndexedEdge, from: NodeId, to: NodeId, graph: Graph, ranking: Ranking): PathStep {
  const ranked = edge.evidence.map((e) => ({ e, penalty: ranking.provenancePenalty?.(e, graph) ?? 0 }))
    .sort((x, y) => x.penalty - y.penalty)
  const chosen = ranked[0]!
  return {
    from, to, direction: chosen.e.source === from && chosen.e.target === to ? 'forward' : 'backward',
    evidence: chosen.e, alternatives: edge.evidence.filter((e) => e !== chosen.e),
    cost: { base: 1, provenancePenalty: chosen.penalty },
  }
}

/** Enumerates bounded simple paths. Cycles and duplicate references cannot repeat nodes/candidates. */
export function candidatePaths(graph: Graph, index: GraphIndex, start: NodeId, end: NodeId, options: { maxHops?: number; limit?: number; ranking?: Ranking } = {}): CandidatePath[] {
  if (!graph.nodes.has(start) || !graph.nodes.has(end)) return []
  const maxHops = options.maxHops ?? 6, limit = options.limit ?? 20, ranking = options.ranking ?? {}
  const raw: { nodes: NodeId[]; edges: IndexedEdge[] }[] = []
  const visit = (at: NodeId, nodes: NodeId[], edges: IndexedEdge[]) => {
    if (raw.length >= 10_000) return
    if (at === end) { raw.push({ nodes: [...nodes], edges: [...edges] }); return }
    if (edges.length === maxHops) return
    for (const next of index.adjacent.get(at) ?? []) {
      if (!nodes.includes(next.node)) visit(next.node, [...nodes, next.node], [...edges, next.edge])
    }
  }
  visit(start, [start], [])
  return raw.map(({ nodes, edges }) => {
    const steps = edges.map((edge, i) => oriented(edge, nodes[i]!, nodes[i + 1]!, graph, ranking))
    const provenancePenalty = steps.reduce((sum, step) => sum + step.cost.provenancePenalty, 0)
    const directionChanges = steps.slice(1).filter((step, i) => step.direction !== steps[i]!.direction).length
    const directionChangePenalty = directionChanges * (ranking.directionChangePenalty ?? 0)
    const hubPenalty = nodes.slice(1, -1).reduce((sum, id) => sum + (ranking.hubPenalty?.(index.degree(id)) ?? 0), 0)
    return { nodes, steps, score: steps.length + provenancePenalty + directionChangePenalty + hubPenalty,
      scoreEvidence: { hops: steps.length, provenancePenalty, directionChanges, directionChangePenalty, hubPenalty } }
  }).sort((a, b) => a.score - b.score || a.nodes.length - b.nodes.length || a.nodes.join('\0').localeCompare(b.nodes.join('\0'))).slice(0, limit)
}

export const contextualRanking: Ranking = {
  directionChangePenalty: 0.4,
  hubPenalty: (degree) => Math.max(0, degree - 2) * 0.25,
  // This is query-time/plugin interpretation, not a stored edge relation.
  provenancePenalty: (evidence, graph) => graph.nodes.get(evidence.source)?.plugin === 'weekly-note' ? 1.5 : 0,
}
