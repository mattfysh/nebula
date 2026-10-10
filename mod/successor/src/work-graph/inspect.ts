import { workFixture } from './fixtures.ts'
import { indexGraph } from './index.ts'
import { candidatePaths, contextualRanking, type CandidatePath } from './paths.ts'
import { checkIntegrity } from './model.ts'

const { graph, extractors } = workFixture({ pluginScheduleReference: true })
const index = indexGraph(graph, extractors)
const query = (label: string, pinned: string, active: string) => ({
  label, pinned, active,
  shortest: candidatePaths(graph, index, pinned, active, { maxHops: 5, limit: 3 }),
  contextual: candidatePaths(graph, index, pinned, active, { maxHops: 5, limit: 3, ranking: contextualRanking }),
})
const output: { integrity: ReturnType<typeof checkIntegrity>; queries: ReturnType<typeof query>[] } = {
  integrity: checkIntegrity(graph, extractors),
  queries: [
    query('launch to gitea deployment', 'launch-watchlist', 'gitea-production'),
    query('adoption to onboarding docs', 'drive-adoption', 'onboarding-documentation'),
    query('platform context to backup verification', 'platform', 'backup-verification'),
  ],
}
console.log(JSON.stringify(output, null, 2))
