import { expect, test } from 'bun:test'
import { builtins } from './providers.ts'
import { discoverModels } from './model-discovery.ts'

test('API model discovery uses provider auth and preserves only known reasoning capabilities', async () => {
  const provider = builtins({}).find((p) => p.id === 'openai')!
  const models = await discoverModels(provider, { OPENAI_API_KEY: 'secret' }, async (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/models')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    return Response.json({ data: [{ id: 'new-model' }, { id: 'gpt-5.2' }] })
  })
  expect(models).toEqual([
    { id: 'new-model', reasoning: [], serviceTiers: [] },
    { id: 'gpt-5.2', reasoning: [], serviceTiers: [] },
  ])
})

test('Anthropic model discovery uses its native authentication and display names', async () => {
  const provider = builtins({}).find((p) => p.id === 'anthropic')!
  const models = await discoverModels(provider, { ANTHROPIC_API_KEY: 'secret' }, async (url, init) => {
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret')
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    return Response.json({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }] })
  })
  expect(models[0]).toMatchObject({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' })
})
