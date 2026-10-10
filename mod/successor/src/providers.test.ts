import { expect, test } from 'bun:test'
import { Agent, type Session } from './agent.ts'
import { builtins, catalog, defaultSelection, validateSelection, loadProviders, type Selection } from './providers.ts'
import { apiOutput, apiRequest } from './provider-api.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = { OPENAI_API_KEY: 'private-openai', ANTHROPIC_API_KEY: 'private-claude', OPENCODE_API_KEY: 'private-zen' }
const providers = builtins({})
const setModels = (id: string, models: any[]) => { providers.find((p) => p.id === id)!.models = models }
setModels('openai', [
  { id: 'gpt-6.1-sol', reasoning: ['low', 'medium', 'high'], serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }] },
  { id: 'gpt-5.2', reasoning: ['none', 'low', 'medium', 'high', 'xhigh'] }, { id: 'gpt-4.1', reasoning: [] },
])
setModels('anthropic', [{ id: 'claude-sonnet-4-6', reasoning: ['low', 'medium', 'high'], reasoningMode: 'adaptive' }, { id: 'claude-sonnet-4-5', reasoning: ['low', 'medium', 'high'], reasoningMode: 'budget' }])
setModels('opencode', [{ id: 'gpt-5.2', reasoning: ['none', 'low', 'medium', 'high', 'xhigh'] }])
setModels('openai-chatgpt', [{ id: 'gpt-6.1-sol', reasoning: ['standard', 'extended'], serviceTiers: [{ id: 'ultrafast', name: 'Ultrafast' }] }])
const fresh = (): Session => ({ version: 1, messages: [] })
const selection = (provider = 'openai', model = 'gpt-5.2', reasoning = 'high', serviceTier: Selection['serviceTier'] = 'default'): Selection => ({ provider, model, reasoning, serviceTier })
test('built-in providers contain no static model or capability data', () => {
  expect(builtins({}).every((provider) => provider.models.length === 0)).toBe(true)
  expect(() => defaultSelection(builtins({}), {})).toThrow('No discovered models')
  expect(defaultSelection(providers, { AI_PROVIDER: 'openai' })).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', reasoning: 'default', serviceTier: 'auto' })
})

const assistant = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }

test('GPT-6.1 Sol API supports independent reasoning and documented speed tiers', () => {
  const api = providers.find((p) => p.id === 'openai')!
  const sol = api.models.find((m) => m.id === 'gpt-6.1-sol')
  expect(sol?.serviceTiers?.map((tier) => tier.id)).toEqual(['fast', 'ultrafast'])
  expect(validateSelection(selection('openai', 'gpt-6.1-sol', 'high', 'ultrafast'), providers, env).model).toEqual(sol!)
})

test('capabilities validate configured reasoning, unknown models default only; catalog omits keys/endpoints', () => {
  expect(validateSelection(selection(), providers, env).selection.reasoning).toBe('high')
  expect(() => validateSelection(selection('openai', 'gpt-4.1'), providers, env)).toThrow('not supported')
  expect(() => validateSelection(selection('openai', 'new-model'), providers, env)).toThrow('not in the provider catalog')
  expect(() => validateSelection(selection('openai', 'new-model', 'default'), providers, env)).toThrow('not in the provider catalog')
  expect(() => validateSelection(selection('missing'), providers, env)).toThrow('Unknown provider')
  expect(() => validateSelection(selection(), providers, {})).toThrow('Set OPENAI_API_KEY')
  expect(() => validateSelection(selection('claude-subscription', 'claude-sonnet-4-6'), providers, env)).toThrow('Subscription integration')
  const publicData = JSON.stringify(catalog(providers, env))
  expect(publicData).not.toContain('private-')
  expect(publicData).not.toContain('baseURL')
  expect(publicData).not.toContain('keyEnv')
})

test('OpenAI function tools execute and reasoning setting is sent; reasoning omitted by default', async () => {
  const session = fresh(), requests: any[] = []
  let calls = 0
  const agent = new Agent(session, {
    env, providers, selection: selection(),
    fetch: async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses')
      expect((init.headers as any).authorization).toBe('Bearer private-openai')
      expect(init.redirect).toBe('error')
      requests.push(JSON.parse(init.body as string))
      return Response.json({ status: 'completed', output: requests.length === 1
        ? [{ type: 'function_call', call_id: 'f1', name: 'bash', arguments: '{"command":"printf ok"}' }]
        : [assistant] })
    },
    run: async (cmd) => { calls++; expect(cmd).toBe('printf ok'); return 'ok' },
  })
  await agent.turn('hello', () => {})
  expect(calls).toBe(1)
  expect(requests[0].reasoning).toEqual({ effort: 'high' })
  const ultraProvider = { ...providers.find((p) => p.id === 'openai-chatgpt')!, protocol: 'responses' as const }
  const ultra = apiRequest(ultraProvider, selection('openai-chatgpt', 'gpt-6.1-sol', 'high', 'ultrafast'), [], '').body as any
  expect(ultra.service_tier).toBe('ultrafast')
  const diagnosticSession = fresh()
  await new Agent(diagnosticSession, { env, providers, selection: selection('openai', 'gpt-6.1-sol', 'high', 'fast'), fetch: async () => Response.json({ status: 'completed', output: [assistant] }) }).turn('fast', () => {})
  expect(diagnosticSession.diagnostics?.[0]?.serviceTier).toBe('fast')
  expect((apiRequest(ultraProvider, selection('openai-chatgpt', 'gpt-6.1-sol', 'high', 'standard'), [], '').body as any).service_tier).toBe('default')
  expect(apiRequest(ultraProvider, selection('openai-chatgpt', 'gpt-6.1-sol', 'high', 'auto'), [], '').body).not.toHaveProperty('service_tier')
  expect(requests[0].tools[0].type).toBe('function')
  expect(requests[1].input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'f1', output: 'ok' })
  expect(apiRequest(providers[0]!, selection('openai', 'gpt-4.1', 'default'), [], '').body).not.toHaveProperty('reasoning')
})

test('Anthropic thinking and tools roundtrip without leaking thinking into emitted text', async () => {
  const requests: any[] = [], texts: string[] = []
  const session = fresh()
  await new Agent(session, {
    env, providers, selection: selection('anthropic', 'claude-sonnet-4-6'),
    fetch: async (url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect((init.headers as any)['x-api-key']).toBe('private-claude')
      expect((init.headers as any).authorization).toBeUndefined()
      requests.push(JSON.parse(init.body as string))
      return Response.json(requests.length === 1 ? { stop_reason: 'tool_use', content: [
        { type: 'thinking', thinking: 'private-thought', signature: 'private-signature' },
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'a1', name: 'bash', input: { command: 'pwd' } },
      ] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] })
    },
    run: async () => '/workspace',
  }).turn('where', (s) => texts.push(s))
  expect(texts).toEqual(['Checking', 'Done'])
  expect(requests[0].thinking).toEqual({ type: 'adaptive' })
  expect(requests[0].output_config).toEqual({ effort: 'high' })
  expect(requests[1].messages[1].content[0].signature).toBe('private-signature')
  expect(requests[1].messages.at(-1).content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a1', content: '/workspace' })
  const budget = apiRequest(providers[1]!, selection('anthropic', 'claude-sonnet-4-5', 'medium'), [], '').body as any
  expect(budget.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  expect(budget.output_config).toBeUndefined()
})

test('OpenCode chat tools and reasoning work; incomplete or malformed tools never execute', async () => {
  const requests: any[] = []
  await new Agent(fresh(), {
    env, providers, selection: selection('opencode'),
    fetch: async (url, init) => {
      expect(url).toBe('https://opencode.ai/zen/v1/chat/completions')
      expect((init.headers as any).authorization).toBe('Bearer private-zen')
      const body = JSON.parse(init.body as string); requests.push(body)
      return Response.json({ choices: [{ finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'z1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] }
        : { role: 'assistant', content: 'Done' } }] })
    }, run: async () => 'result',
  }).turn('hello', () => {})
  expect(requests[0].reasoning_effort).toBe('high')
  expect(requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'z1', content: 'result' })
  expect(() => apiOutput(providers[2]!, { choices: [{ finish_reason: 'length', message: {} }] })).toThrow()
  expect(() => apiOutput(providers[1]!, { stop_reason: 'max_tokens', content: [] })).toThrow()
  let ran = false
  await expect(new Agent(fresh(), {
    env, providers, selection: selection(),
    fetch: async () => Response.json({ status: 'completed', output: [
      { type: 'function_call', call_id: 'valid', name: 'bash', arguments: '{"command":"pwd"}' },
      { type: 'function_call', call_id: 'bad', name: 'bash', arguments: '{"secret":"DO-NOT-LEAK"}' },
    ] }), run: async () => { ran = true; return '' },
  }).turn('hi', () => {})).rejects.toThrow('Invalid provider response')
  expect(ran).toBe(false)
})

test('switching provider/model strips native reasoning and IDs but retains visible context', async () => {
  const session: Session = { version: 1, backend: 'openai:gpt-5.2', messages: [
    { role: 'user', content: 'remember' },
    { type: 'reasoning', encrypted_content: 'private-opaque' },
    { type: 'custom_tool_call', call_id: 'private-native-id', name: 'bash', input: 'pwd' },
    { type: 'custom_tool_call_output', call_id: 'private-native-id', output: '/workspace' },
    assistant,
  ] }
  await new Agent(session, {
    env, providers, selection: selection('anthropic', 'claude-sonnet-4-6', 'default'),
    fetch: async (_, init) => {
      const body = String(init.body)
      expect(body).not.toContain('private-')
      expect(body).toContain('/workspace')
      expect(body).toContain('remember')
      expect(body).not.toContain('"thinking"')
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] })
    },
  }).turn('continue', () => {})
  expect(session.backend).toBe('anthropic:claude-sonnet-4-6')
})

test('invalid selections fail before mutating history', async () => {
  const session = fresh()
  await expect(new Agent(session, { env, providers, selection: selection('openai', 'gpt-4.1') }).turn('do not append', () => {})).rejects.toThrow('Provider configuration unavailable')
  expect(session.messages).toEqual([])
  expect(session.diagnostics?.at(-1)?.category).toBe('configuration')
})

test('server profiles extend providers and model capabilities without including credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-providers-'))
  try {
    const path = join(directory, 'providers.json')
    await Bun.write(path, JSON.stringify([{
      id: 'local', label: 'Local API', protocol: 'chat', baseURL: 'http://127.0.0.1:1234/v1',
      models: [{ id: 'local-model', reasoning: ['low', 'high'] }],
    }]))
    const loaded = await loadProviders({ PROVIDERS_FILE: path })
    expect(loaded.find((p) => p.id === 'local')?.models).toEqual([])
    expect(loaded).toHaveLength(providers.length + 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
