import { expect, test } from 'bun:test'
import { completedResponse } from './chatgpt.ts'

test('response text deltas are emitted before the authoritative completion', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.output_item.done', item: { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]
  const response = new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const deltas: string[] = []
  const complete: any = await completedResponse(response, undefined, (text) => deltas.push(text))
  expect(deltas).toEqual(['Hel', 'lo'])
  expect(complete.output[0].content[0].text).toBe('Hello')
})

import { chatgptModels } from './chatgpt.ts'
import { ChatGPTAuth } from './chatgpt-auth.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('ChatGPT model metadata exposes advertised speed tiers using their exact request IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-models-'))
  try {
    const token = 'x.' + Buffer.from(JSON.stringify({ chatgpt_account_id: 'account' })).toString('base64url') + '.x'
    await Bun.write(join(directory, 'chatgpt-auth.json'), JSON.stringify({ version: 1, accessToken: token, refreshToken: 'refresh', accountId: 'account', expiresAt: Date.now() + 3_600_000 }))
    const auth = await ChatGPTAuth.open(directory, { automatic: false })
    const models = await chatgptModels(auth, async (url) => {
      expect(url).toContain('/backend-api/codex/models?client_version=0.162.1')
      return Response.json({ models: [{ slug: 'gpt-6.1-sol', title: 'GPT-6.1 Sol', thinking_efforts: [{ thinking_effort: 'standard' }, { thinking_effort: 'extended' }], service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] }] })
    })
    expect(models[0]).toMatchObject({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoning: ['standard', 'extended'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] })
    await auth.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
