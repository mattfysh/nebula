import { z } from 'zod'

export const Selection = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().trim().min(1).max(160).regex(/^[\w./:+-]+$/),
  reasoning: z.string().max(40).default('default'),
}).strict()
export type Selection = z.infer<typeof Selection>
export const Model = z.object({
  id: Selection.shape.model,
  reasoning: z.array(z.string().min(1).max(40)).default([]),
  reasoningMode: z.enum(['effort', 'budget', 'adaptive']).optional(),
})
export const Provider = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), label: z.string(),
  protocol: z.enum(['responses', 'chat', 'anthropic', 'codex', 'opencode', 'chatgpt', 'unavailable']),
  baseURL: z.string().url().optional(),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  models: z.array(Model).min(1),
  note: z.string().optional(),
})
export type Provider = z.infer<typeof Provider>
export type Environment = Record<string, string | undefined>
const effort = ['low', 'medium', 'high']
export function builtins(env: Environment = process.env): Provider[] {
  return [
    { id: 'openai', label: 'OpenAI API', protocol: 'responses',
      baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY',
      models: [
        { id: env.OPENAI_MODEL ?? 'gpt-6-astra', reasoning: [] },
        { id: 'gpt-5.2', reasoning: ['none', ...effort, 'xhigh'] },
        { id: 'gpt-5', reasoning: ['minimal', ...effort] },
        { id: 'gpt-4.1', reasoning: [] },
      ].filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i) },
    { id: 'anthropic', label: 'Claude API', protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY',
      models: [
        { id: 'claude-sonnet-4-6', reasoning: effort, reasoningMode: 'adaptive' },
        { id: 'claude-opus-4-6', reasoning: [...effort, 'max'], reasoningMode: 'adaptive' },
        { id: 'claude-sonnet-4-5', reasoning: effort, reasoningMode: 'budget' },
      ] },
    { id: 'opencode', label: 'OpenCode Zen (API)', protocol: 'chat',
      baseURL: 'https://opencode.ai/zen/v1', keyEnv: 'OPENCODE_API_KEY',
      models: [{ id: 'gpt-5.2', reasoning: ['none', ...effort, 'xhigh'] }],
      note: 'OpenAI-compatible Zen models. For other Zen model protocols, add a provider profile.' },
    { id: 'openai-chatgpt', label: 'OpenAI — ChatGPT subscription (direct)', protocol: 'chatgpt',
      models: [
        { id: 'gpt-5.2-codex', reasoning: [...effort, 'xhigh'] },
        { id: 'gpt-5.3-codex', reasoning: [...effort, 'xhigh'] },
      ],
      note: 'Connect ChatGPT in this app. No API key, Codex or OpenCode executable. Codex-compatible OAuth; OpenAI may label the login Codex. Fallback model catalog, not verified account access.' },
    { id: 'openai-subscription-opencode', label: 'OpenAI subscription (OpenCode)', protocol: 'opencode',
      models: [{ id: 'openai/gpt-5.2-codex', reasoning: [...effort, 'xhigh'] }],
      note: 'Uses OpenCode’s OpenAI ChatGPT login, not Zen or Codex CLI. Set ENABLE_OPENCODE_SUBSCRIPTION=1. OpenCode owns auth, tools, permissions and local history.' },
    { id: 'openai-subscription', label: 'OpenAI subscription (Codex CLI)', protocol: 'codex',
      models: [{ id: 'gpt-5.2-codex', reasoning: [...effort, 'xhigh'] }],
      note: 'Requires official codex CLI, codex login, and ENABLE_CODEX_SUBSCRIPTION=1. Uses Codex’s own workspace-write sandbox/tools; availability depends on your plan.' },
    { id: 'claude-subscription', label: 'Claude subscription (not integrated)', protocol: 'unavailable',
      models: [{ id: 'claude-sonnet-4-6', reasoning: [] }],
      note: 'No subscription-token reuse or unofficial OAuth. Use Claude API here; subscription integration is not enabled pending an explicitly supported third-party route.' },
  ]
}
export async function loadProviders(env: Environment = process.env): Promise<Provider[]> {
  const providers = builtins(env)
  if (env.PROVIDERS_FILE) {
    const extra = z.array(Provider.strict()).parse(await Bun.file(env.PROVIDERS_FILE).json())
    for (const provider of extra) {
      const index = providers.findIndex((p) => p.id === provider.id)
      if (index < 0) providers.push(provider)
      else providers[index] = provider
    }
  }
  return providers
}
export function availability(p: Provider, env: Environment = process.env) {
  if (p.protocol === 'unavailable') return p.note ?? 'Not supported'
  if (p.protocol === 'codex')
    return env.ENABLE_CODEX_SUBSCRIPTION === '1' && Bun.which('codex', { PATH: env.PATH }) ? undefined : 'Install/login to Codex CLI and set ENABLE_CODEX_SUBSCRIPTION=1'
  if (p.protocol === 'opencode')
    return env.ENABLE_OPENCODE_SUBSCRIPTION === '1' && Bun.which('opencode', { PATH: env.PATH }) ? undefined : 'Sign in to OpenAI with OpenCode and set ENABLE_OPENCODE_SUBSCRIPTION=1 (no Codex needed)'
  if (p.protocol === 'chatgpt') return undefined // Connection is checked at turn time, not while editing settings.
  if (!p.baseURL) return 'Missing base URL'
  if (p.keyEnv && !env[p.keyEnv]) return `Set ${p.keyEnv} on the server`
  return undefined
}
export function catalog(providers: Provider[], env: Environment = process.env, chatgptConnected = false) {
  return providers.map((p) => ({
    id: p.id, label: p.label, models: p.models, note: p.note,
    connectable: p.protocol === 'chatgpt',
    unavailable: p.protocol === 'chatgpt' && !chatgptConnected ? 'Connect ChatGPT' : availability(p, env),
  }))
}
export function validateSelection(value: unknown, providers: Provider[], env: Environment = process.env) {
  const selection = Selection.parse(value)
  const provider = providers.find((p) => p.id === selection.provider)
  if (!provider) throw new Error('Unknown provider')
  const unavailable = availability(provider, env)
  if (unavailable) throw new Error(unavailable)
  if (provider.protocol === 'opencode' && !selection.model.startsWith('openai/'))
    throw new Error('OpenCode subscription models must use openai/<model>.')
  const model = provider.models.find((m) => m.id === selection.model)
  if (selection.reasoning !== 'default' && !model?.reasoning.includes(selection.reasoning))
    throw new Error('Reasoning level is not supported for this model; use default or configure its capabilities.')
  if (selection.reasoning !== 'default' && provider.protocol === 'anthropic') {
    const supported = model?.reasoningMode === 'budget' ? ['low', 'medium', 'high']
      : model?.reasoningMode === 'adaptive' ? ['low', 'medium', 'high', 'max'] : []
    if (!supported.includes(selection.reasoning))
      throw new Error('Configure a supported Claude reasoning mode and level.')
  }
  return { selection, provider, model }
}
export function defaultSelection(providers: Provider[], env: Environment = process.env): Selection {
  const provider = env.AI_PROVIDER ?? 'openai'
  return Selection.parse({
    provider,
    model: env.AI_MODEL ?? providers.find((p) => p.id === provider)?.models[0]?.id ?? 'gpt-6-astra',
    reasoning: env.AI_REASONING ?? 'default',
  })
}
