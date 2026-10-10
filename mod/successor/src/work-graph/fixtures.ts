import type { Extractors, Graph, Node } from './model.ts'

const node = (id: string, plugin: string, title: string, content: string[] = [], extra: Record<string, unknown> = {}): Node =>
  ({ id, plugin, data: { title, ...extra }, content })

/** Neutral facts: arrays are ordered mentions; IDs are reused wherever the same work appears. */
export function workFixture(options: { pluginScheduleReference?: boolean } = {}): { graph: Graph; extractors: Extractors } {
  const nodes = [
    node('launch-watchlist', 'text', 'Launch Watchlist', ['watchlist-production', 'watchlist-material']),
    node('watchlist-production', 'text', 'Deploy Watchlist to production', ['gitea-production']),
    node('gitea-production', 'text', 'Deploy Gitea to production'),
    node('watchlist-material', 'text', 'Watchlist launch material', ['gitea-production', 'watchlist']),
    node('platform', 'text', 'Platform', ['platform-notes']),
    node('platform-notes', 'text', 'Platform notes', ['gitea', 'gitea-production']),
    node('gitea', 'text', 'Gitea'),
    node('operations-handbook', 'text', 'Operational handbook', ['gitea-production', 'backup-verification']),
    node('backup-verification', 'schedule', 'Verify backups', [], { handbook: 'operations-handbook', cadence: 'weekly' }),
    node('drive-adoption', 'text', 'Drive Watchlist adoption', ['watchlist', 'onboarding-documentation']),
    node('onboarding-documentation', 'text', 'Write onboarding documentation'),
    node('watchlist', 'text', 'Watchlist'),
    // Incidental co-mention creates a deceptively short path.
    node('weekly-note', 'weekly-note', 'Weekly note', ['launch-watchlist', 'gitea-production', 'watchlist', 'onboarding-documentation']),
  ]
  const graph = { nodes: new Map(nodes.map((n) => [n.id, n])), names: new Map([['watchlist', 'launch-watchlist'], ['platform', 'platform']]) }
  const extractors: Extractors = options.pluginScheduleReference ? new Map([['schedule', (n) => {
    const target = (n.data as { handbook?: unknown }).handbook
    return typeof target === 'string' ? [{ target, path: '$.handbook' }] : []
  }]]) : new Map()
  return { graph, extractors }
}
