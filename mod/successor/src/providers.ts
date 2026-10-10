import { z } from 'zod'

export const Selection = z.object({
  provider: z.string().min(1).max(80), model: z.string().trim().min(1).max(160).regex(/^[\w./:+-]+$/),
  reasoning: z.string().max(40).default('default'),
  // `auto` (and legacy `default`) omit service_tier; `standard` sends wire value `default`.
  serviceTier: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/).optional(),
}).strict()
export type Selection = z.infer<typeof Selection>
export const ServiceTier = z.object({ id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(80), description: z.string().max(240).optional(), available: z.boolean().optional(), unavailableReason: z.string().max(160).optional() })
export const Model = z.object({
  id: Selection.shape.model, label: z.string().min(1).max(120).optional(),
  reasoning: z.array(z.string().min(1).max(40)).default([]),
  unavailableReasoning: z.array(z.string().min(1).max(40)).optional(),
  reasoningMode: z.enum(['effort', 'budget', 'adaptive']).optional(), serviceTiers: z.array(ServiceTier).optional(),
})
export const Provider = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), label: z.string(),
  protocol: z.enum(['responses', 'chat', 'anthropic', 'codex', 'opencode', 'chatgpt', 'unavailable']),
  baseURL: z.string().url().optional(), keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  models: z.array(Model).default([]), note: z.string().optional(),
})
export type Provider = z.infer<typeof Provider>
export type Environment = Record<string, string | undefined>
export type Discovery = { status: 'pending' | 'ready' | 'error', error?: string }
export const DEFAULT_PROVIDER = 'openai-chatgpt'
export function builtins(_env: Environment = process.env): Provider[] {
  return [
    { id: 'openai', label: 'OpenAI API', protocol: 'responses', baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: [] },
    { id: 'anthropic', label: 'Claude API', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: [] },
    { id: 'opencode', label: 'OpenCode Zen (API)', protocol: 'chat', baseURL: 'https://opencode.ai/zen/v1', keyEnv: 'OPENCODE_API_KEY', models: [] },
    { id: 'openai-chatgpt', label: 'OpenAI — ChatGPT subscription (direct)', protocol: 'chatgpt', models: [], note: 'Connect ChatGPT to load the account model catalog.' },
    { id: 'openai-subscription-opencode', label: 'OpenAI subscription (OpenCode)', protocol: 'opencode', models: [], note: 'Model discovery for this CLI-backed provider is not integrated.' },
    { id: 'openai-subscription', label: 'OpenAI subscription (Codex CLI)', protocol: 'codex', models: [], note: 'Model discovery for this CLI-backed provider is not integrated.' },
    { id: 'claude-subscription', label: 'Claude subscription (not integrated)', protocol: 'unavailable', models: [], note: 'Subscription integration is not available.' },
  ]
}
export async function loadProviders(env: Environment = process.env): Promise<Provider[]> {
  const providers = builtins()
  if (env.PROVIDERS_FILE) {
    const extra = z.array(Provider.strict()).parse(await Bun.file(env.PROVIDERS_FILE).json())
    for (const provider of extra) {
      // Profile model data is deliberately discarded: catalogs are authoritative.
      provider.models = []
      const index = providers.findIndex((p) => p.id === provider.id)
      if (index < 0) providers.push(provider); else providers[index] = provider
    }
  }
  return providers
}
export function availability(p: Provider, env: Environment = process.env, discovery?: Discovery) {
  if (p.protocol === 'unavailable') return p.note ?? 'Not supported'
  if (p.protocol === 'codex' && !p.models.length) return discovery?.error ?? 'Model discovery for Codex CLI is unavailable.'
  if (p.protocol === 'opencode' && !p.models.length) return discovery?.error ?? 'Model discovery for OpenCode CLI is unavailable.'
  if (!['chatgpt', 'codex', 'opencode'].includes(p.protocol)) {
    if (!p.baseURL) return 'Missing base URL'
    if (p.keyEnv && !env[p.keyEnv]) return `Set ${p.keyEnv} on the server`
  }
  const state = discovery ?? (p.models.length ? { status: 'ready' as const } : { status: 'pending' as const })
  if (state.status !== 'ready') return state.error ?? 'Model catalog has not been loaded.'
  if (!p.models.length) return 'Provider returned no usable models.'
  return undefined
}
export function catalog(providers: Provider[], env: Environment = process.env, chatgptConnected = false, discoveries: Map<string, Discovery> = new Map()) {
  return providers.map((p) => ({
    id: p.id, label: p.label, models: p.models, note: p.note,
    connectable: p.protocol === 'chatgpt', modelDiscovery: p.protocol === 'chatgpt' || ['responses', 'chat', 'anthropic'].includes(p.protocol),
    supportsServiceTier: ['responses', 'chat', 'chatgpt', 'codex'].includes(p.protocol),
    unavailable: p.protocol === 'chatgpt' && !chatgptConnected ? 'Connect ChatGPT to load models.' : availability(p, env, discoveries.get(p.id)),
  }))
}
export function validateSelection(value: unknown, providers: Provider[], env: Environment = process.env, discoveries?: Map<string, Discovery>) {
  const selection = Selection.parse(value), provider = providers.find((p) => p.id === selection.provider)
  if (!provider) throw new Error('Unknown provider')
  const unavailable = availability(provider, env, discoveries?.get(provider.id))
  if (unavailable) throw new Error(unavailable)
  if (provider.protocol === 'opencode' && !selection.model.startsWith('openai/')) throw new Error('OpenCode subscription models must use openai/<model>.')
  const model = provider.models.find((m) => m.id === selection.model)
  if (!model) throw new Error('Model is not in the provider catalog.')
  if (selection.reasoning !== 'default' && !model.reasoning.includes(selection.reasoning)) throw new Error('Reasoning level is not supported for this model.')
  if (selection.serviceTier && !['auto', 'default', 'standard'].includes(selection.serviceTier) && !model.serviceTiers?.some((tier) => tier.id === selection.serviceTier && tier.available !== false)) throw new Error('Service tier is not supported for this model.')
  if (selection.serviceTier && !['auto', 'default'].includes(selection.serviceTier) && !['responses', 'chat', 'chatgpt', 'codex'].includes(provider.protocol)) throw new Error('Service tier is not supported by this provider.')
  return { selection, provider, model }
}
export function defaultSelection(providers: Provider[], env: Environment = process.env): Selection {
  const provider = env.AI_PROVIDER ?? DEFAULT_PROVIDER
  const available = providers.find((p) => p.id === provider)?.models ?? []
  const model = env.AI_MODEL ?? available.find((model) => model.id === 'gpt-6.1-sol')?.id ?? available[0]?.id
  if (!model) throw new Error(`No discovered models for default provider ${provider}.`)
  return Selection.parse({ provider, model, reasoning: env.AI_REASONING ?? 'default', serviceTier: env.AI_SERVICE_TIER ?? 'auto' })
}
