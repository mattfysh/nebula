import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, recover, save, shell, type Session } from './agent.ts'
import { builtins } from './providers.ts'

const fresh = (): Session => ({ version: 1, messages: [] })
const providers = builtins({}); providers.find((p) => p.id === 'openai')!.models = [{ id: 'test-model', reasoning: [] }]
const configured = { providers, selection: { provider: 'openai', model: 'test-model', reasoning: 'default' } as const }
const message = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})
const tool = (name = 'bash') => ({
  type: 'custom_tool_call',
  name,
  input: 'printf hello',
  call_id: 'call-1',
})
function fake(outputs: unknown[][], requests: any[] = []) {
  return (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    return Response.json({ status: 'completed', output: outputs.shift() })
  }) as (url: string, init: RequestInit) => Promise<Response>
}

describe('agent loop', () => {
  test('preserves reasoning and tool outputs, then continues the conversation', async () => {
    const session = fresh()
    const requests: any[] = []
    const texts: string[] = []
    let runs = 0
    let checkpoints = 0
    const agent = new Agent(session, {
      ...configured, apiKey: 'test-only',
      fetch: fake(
        [
          [{ type: 'reasoning', encrypted_content: 'opaque' }, tool()],
          [message('Hello')],
          [message('Still here')],
        ],
        requests,
      ),
      run: async (command) => {
        runs++
        expect(command).toBe('printf hello')
        return 'hello'
      },
      checkpoint: async () => {
        checkpoints++
      },
    })
    await agent.turn('First', (text) => texts.push(text))
    await agent.turn('Second', (text) => texts.push(text))
    expect(texts).toEqual(['Hello', 'Still here'])
    expect(runs).toBe(1)
    expect(checkpoints).toBe(17) // Includes durable phase and terminal-attempt checkpoints.
    expect(requests[1].input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'hello',
    })
    expect(requests[2].input).toContainEqual(message('Hello'))
    expect(requests[0].store).toBe(false)
    expect(requests[0].include).toEqual(['reasoning.encrypted_content'])
  })

  test('unknown tools produce a result without executing shell', async () => {
    let ran = false
    const session = fresh()
    const agent = new Agent(session, {
      ...configured, apiKey: 'test',
      fetch: fake([[tool('other')], [message('Done')]]),
      run: async () => {
        ran = true
        return ''
      },
    })
    await agent.turn('Hi', () => {})
    expect(ran).toBe(false)
    expect(session.messages[2]?.output).toBe('Unknown tool: other')
  })

  test('HTTP failures retain history and do not leak response bodies', async () => {
    const session = fresh()
    const agent = new Agent(session, {
      ...configured, apiKey: 'test',
      fetch: (async () => new Response('SECRET', { status: 401 })) as (
        url: string,
        init: RequestInit,
      ) => Promise<Response>,
    })
    await expect(agent.turn('Hi', () => {})).rejects.toThrow('HTTP 401')
    expect(session.messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  test('rejects incomplete responses before executing tools', async () => {
    let ran = false
    const agent = new Agent(fresh(), {
      ...configured, apiKey: 'test',
      fetch: (async () => Response.json({ status: 'incomplete', output: [tool()] })) as (
        url: string,
        init: RequestInit,
      ) => Promise<Response>,
      run: async () => {
        ran = true
        return ''
      },
    })
    await expect(agent.turn('Hi', () => {})).rejects.toThrow()
    expect(ran).toBe(false)
  })

  test('caps autonomous tool steps', async () => {
    const session = fresh()
    const agent = new Agent(session, {
      ...configured, apiKey: 'test',
      maxSteps: 1,
      fetch: fake([[tool()]]),
      run: async () => 'ok',
    })
    await expect(agent.turn('Hi', () => {})).rejects.toThrow('Tool-step limit')
    expect(session.messages.at(-1)?.type).toBe('custom_tool_call_output')
  })

  test('emits refusals', async () => {
    const texts: string[] = []
    const agent = new Agent(fresh(), {
      ...configured, apiKey: 'test',
      fetch: fake([[{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }]]),
    })
    await agent.turn('Hi', (text) => texts.push(text))
    expect(texts).toEqual(['No'])
  })
})

test('shell captures stdout/stderr and nonzero status', async () => {
  const result = await shell('printf out; printf err >&2; exit 7')
  expect(result).toContain('out')
  expect(result).toContain('err')
  expect(result).toContain('exit code: 7')
})

test('shell truncates while draining output', async () => {
  const result = await shell('head -c 100000 /dev/zero', 1000, 64)
  expect(result).toContain('[output truncated]')
  expect(result.length).toBeLessThan(150)
  expect(result).toContain('exit code: 0')
})

test('shell timeout kills ordinary descendants', async () => {
  const started = Date.now()
  const result = await shell('sleep 30 & wait', 100)
  expect(result).toContain('[tool timed out]')
  expect(Date.now() - started).toBeLessThan(3000)
})

test('atomic session roundtrip and idempotent interrupted-call recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-'))
  try {
    const path = join(directory, 'session.json')
    const session = fresh()
    session.messages.push(tool())
    await save(path, session)
    const loaded = JSON.parse(await readFile(path, 'utf8')) as Session
    recover(loaded)
    recover(loaded)
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages[1]?.output).toContain('may have run')
    await save(path, loaded)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(loaded)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
