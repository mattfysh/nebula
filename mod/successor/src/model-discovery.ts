import { z } from 'zod'
import { boundedJson, type Fetch } from './chatgpt-auth.ts'
import { Model, type Environment, type Provider } from './providers.ts'

const entry = z.object({
  id: Model.shape.id,
  display_name: z.string().min(1).max(120).optional(),
}).passthrough()
const response = z.object({ data: z.array(entry).max(5000) }).passthrough()

export function canDiscoverModels(provider: Provider) {
  return ['responses', 'chat', 'anthropic'].includes(provider.protocol) && !!provider.baseURL
}

// Standard API providers expose model IDs, but generally not reasoning controls.
// Retain configured capabilities for matching IDs and treat new IDs conservatively.
export async function discoverModels(provider: Provider, env: Environment = process.env, request: Fetch = fetch) {
  if (!canDiscoverModels(provider)) throw new Error('This provider does not expose an HTTP model catalog.')
  if (!provider.baseURL) throw new Error('Missing base URL')
  if (provider.keyEnv && !env[provider.keyEnv]) throw new Error(`Set ${provider.keyEnv} on the server`)
  const key = provider.keyEnv ? env[provider.keyEnv] : undefined
  const headers: Record<string, string> = { accept: 'application/json' }
  if (provider.protocol === 'anthropic') {
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (key) headers.authorization = `Bearer ${key}`
  const result = await request(`${provider.baseURL!.replace(/\/$/, '')}/models`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers,
  })
  if (!result.ok) throw new Error(`Model discovery failed (HTTP ${result.status}).`)
  const data = response.parse(await boundedJson(result))
  const configured = new Map(provider.models.map((model) => [model.id, model]))
  const unique = new Map<string, z.infer<typeof Model>>()
  for (const item of data.data) {
    const known = configured.get(item.id)
    unique.set(item.id, Model.parse({
      id: item.id,
      ...(item.display_name || known?.label ? { label: item.display_name ?? known?.label } : {}),
      reasoning: known?.reasoning ?? [],
      ...(known?.reasoningMode ? { reasoningMode: known.reasoningMode } : {}),
      serviceTiers: known?.serviceTiers ?? [],
    }))
  }
  if (!unique.size) throw new Error('Provider returned no models.')
  return [...unique.values()]
}
