import { describe, expect, test } from 'bun:test'
import { workFixture } from './fixtures.ts'
import { indexGraph } from './index.ts'
import { checkIntegrity, resolveName, type Graph } from './model.ts'
import { candidatePaths, contextualRanking } from './paths.ts'

describe('foundational graph', () => {
  test('checks IDs and references, resolves mutable names, and indexes backlinks', () => {
    const { graph } = workFixture(); const index = indexGraph(graph)
    expect(checkIntegrity(graph)).toEqual([])
    expect(resolveName(graph, 'watchlist')?.id).toBe('launch-watchlist')
    graph.names.set('watchlist', 'drive-adoption')
    expect(resolveName(graph, 'watchlist')?.id).toBe('drive-adoption')
    expect(index.backlinks.get('gitea-production')?.map((x) => x.source).sort()).toEqual(['operations-handbook', 'platform-notes', 'watchlist-material', 'watchlist-production', 'weekly-note'])
  })

  test('reports dangling content, extracted references, and names', () => {
    const graph: Graph = { nodes: new Map([['wrong-key', { id: 'a', plugin: 'x', data: { link: 'missing-data' }, content: ['missing-content'] }]]), names: new Map([['bad', 'missing-name']]) }
    const extractors = new Map([['x', () => [{ target: 'missing-data', path: '$.link' }]]])
    expect(checkIntegrity(graph, extractors).map((x) => x.kind)).toEqual(['node-key-mismatch', 'missing-reference', 'missing-reference', 'missing-name-target'])
  })

  test('one shared node needs no placement object and paths retain traversal evidence', () => {
    const { graph } = workFixture(); const index = indexGraph(graph)
    expect([...graph.nodes.values()].filter((n) => n.id === 'gitea-production')).toHaveLength(1)
    const path = candidatePaths(graph, index, 'launch-watchlist', 'gitea-production', { maxHops: 3, limit: 1 })[0]!
    expect(path.nodes).toEqual(['launch-watchlist', 'watchlist-material', 'gitea-production'])
    expect(path.steps.map((x) => x.direction)).toEqual(['forward', 'forward'])
    const reverse = candidatePaths(graph, index, 'gitea-production', 'launch-watchlist', { maxHops: 2, limit: 1 })[0]!
    expect(reverse.steps.map((x) => x.direction)).toEqual(['backward', 'backward'])
  })

  test('cycles and repeated references do not repeat nodes or candidate paths', () => {
    const graph: Graph = { nodes: new Map([
      ['a', { id: 'a', plugin: 'x', data: {}, content: ['b', 'b'] }],
      ['b', { id: 'b', plugin: 'x', data: {}, content: ['a', 'c'] }],
      ['c', { id: 'c', plugin: 'x', data: {}, content: [] }],
    ]), names: new Map() }
    const paths = candidatePaths(graph, indexGraph(graph), 'a', 'c', { maxHops: 5 })
    expect(paths.map((x) => x.nodes)).toEqual([['a', 'b', 'c']])
    expect(paths[0]!.steps[0]!.alternatives).toHaveLength(2) // duplicate plus reverse evidence preserved
  })
})

describe('representation and ranking experiments', () => {
  test('content alone infers scheduled operational context only when handbook contains the item', () => {
    const plain = workFixture(); const plainIndex = indexGraph(plain.graph)
    expect(candidatePaths(plain.graph, plainIndex, 'operations-handbook', 'backup-verification')[0]!.nodes).toEqual(['operations-handbook', 'backup-verification'])
    const handbook = plain.graph.nodes.get('operations-handbook')!
    handbook.content = handbook.content.filter((id) => id !== 'backup-verification')
    expect(candidatePaths(plain.graph, indexGraph(plain.graph), 'operations-handbook', 'backup-verification')).toEqual([])
  })

  test('minimal plugin extraction makes a private schedule reference traversable with provenance', () => {
    const { graph, extractors } = workFixture({ pluginScheduleReference: true })
    graph.nodes.get('operations-handbook')!.content = ['gitea-production']
    const path = candidatePaths(graph, indexGraph(graph, extractors), 'operations-handbook', 'backup-verification')[0]!
    expect(path.nodes).toEqual(['operations-handbook', 'backup-verification'])
    expect(path.steps[0]!.evidence.provenance).toEqual({ kind: 'plugin-data', plugin: 'schedule', path: '$.handbook' })
  })

  test('hop count ties incidental co-mention with useful paths; provenance-aware ranking rejects it', () => {
    const { graph } = workFixture(); const index = indexGraph(graph)
    const shortest = candidatePaths(graph, index, 'launch-watchlist', 'gitea-production', { maxHops: 4, limit: 5 })
    const incidental = shortest.find((path) => path.nodes.join('/') === 'launch-watchlist/weekly-note/gitea-production')!
    expect(incidental.score).toBe(shortest[0]!.score)
    const ranked = candidatePaths(graph, index, 'launch-watchlist', 'gitea-production', { maxHops: 4, limit: 1, ranking: contextualRanking })[0]!
    expect(ranked.nodes).toEqual(['launch-watchlist', 'watchlist-production', 'gitea-production'])
    expect(ranked.scoreEvidence).toEqual({ hops: 2, provenancePenalty: 0, directionChanges: 0, directionChangePenalty: 0, hubPenalty: 0 })
  })

  test('direct adoption-to-document reference remains preferred despite weekly note hub', () => {
    const { graph } = workFixture(); const paths = candidatePaths(graph, indexGraph(graph), 'drive-adoption', 'onboarding-documentation', { maxHops: 4, limit: 2, ranking: contextualRanking })
    expect(paths[0]!.nodes).toEqual(['drive-adoption', 'onboarding-documentation'])
    expect(paths[1]!.nodes).toEqual(['drive-adoption', 'watchlist', 'weekly-note', 'onboarding-documentation'])
    expect(paths[1]!.scoreEvidence.provenancePenalty).toBe(3)
  })
})
