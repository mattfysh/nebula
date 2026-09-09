import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type Session } from './agent.ts'
import { builtins, validateSelection, availability } from './providers.ts'

const selection = { provider: 'openai-subscription-opencode', model: 'openai/gpt-5.2-codex', reasoning: 'high' }
const providers = builtins({})
async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), 'successor-opencode-'))
  const executable = join(directory, 'opencode')
  await writeFile(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o700 })
  return {
    directory, executable,
    env: { PATH: directory, ENABLE_OPENCODE_SUBSCRIPTION: '1',
      OPENAI_API_KEY: 'do-not-use', CODEX_API_KEY: 'do-not-use',
      OPENCODE_AUTO_SHARE: 'true', OPENCODE_CONFIG_CONTENT: '{"share":"auto","theme":"test"}' },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
const event = (value: unknown) => `console.log(${JSON.stringify(JSON.stringify(value))});`
const tool = {
  type: 'tool_use', part: { id: 't1', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace' } },
}
const finish = { type: 'step_finish', part: { id: 'finish', reason: 'stop' } }

test('OpenCode subscription needs no Codex, uses namespaced model/variant and delegates login', async () => {
  const f = await fixture(`
const args = process.argv.slice(2)
if (JSON.stringify(args) !== JSON.stringify(['run','--format','json','--model','openai/gpt-5.2-codex','--agent','build','--variant','high'])) process.exit(2)
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENCODE_AUTO_SHARE !== 'false') process.exit(3)
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
if (config.share !== 'disabled' || config.theme !== 'test' || config.provider.openai.options.apiKey !== 'subscription-oauth-required') process.exit(4)
if (JSON.stringify(config.enabled_providers) !== '["openai"]' || config.small_model !== 'openai/gpt-5.2-codex') process.exit(5)
const prompt = await Bun.stdin.text()
if (!prompt.includes('remember') || prompt.includes('private-opaque')) process.exit(6)
${event({ type: 'reasoning', part: { id: 'secret', text: 'PRIVATE-THINKING' } })}
${event(tool)}
${event(tool)}
${event({ type: 'text', part: { id: 'text1', text: 'Done' } })}
${event(finish)}
`)
  try {
    expect(Bun.which('codex', { PATH: f.env.PATH })).toBeNull()
    expect(validateSelection(selection, providers, f.env).provider.protocol).toBe('opencode')
    const session: Session = { version: 1, messages: [
      { role: 'user', content: 'remember' }, { type: 'reasoning', encrypted_content: 'private-opaque' },
    ] }
    const text: string[] = []
    await new Agent(session, {
      env: f.env, providers, selection,
      fetch: async () => { throw new Error('No API route') },
      run: async () => { throw new Error('Do not replay OpenCode tools') },
    }).turn('continue', (s) => text.push(s))
    expect(text).toEqual(['Done'])
    expect(session.messages.filter((m) => m.type === 'custom_tool_call')).toHaveLength(1)
    expect(session.messages.find((m) => m.type === 'custom_tool_call_output')?.output).toBe('/workspace')
    expect(JSON.stringify(session)).not.toContain('PRIVATE-THINKING')
    expect(session.selection).toEqual(selection)
    expect(availability(providers.find((p) => p.id === selection.provider)!, { PATH: f.env.PATH })).toContain('ENABLE_OPENCODE_SUBSCRIPTION')
    expect(() => validateSelection({ ...selection, model: 'anthropic/claude-sonnet-4-6' }, providers, f.env)).toThrow('openai/<model>')
  } finally { await f.cleanup() }
})

test('OpenCode defaults omit variant; all tool types are retained, no raw auth errors', async () => {
  const f = await fixture(`
if (process.argv.includes('--variant')) process.exit(2)
await Bun.stdin.text()
${event({ type: 'tool_use', part: { id: 'edit1', tool: 'edit', state: { status: 'completed', input: { filePath: 'file.ts' }, output: 'Edited' } } })}
${event({ type: 'error', error: { message: 'PRIVATE-AUTH-ERROR' } })}
console.error('PRIVATE-STDERR')
${event(finish)}
`)
  try {
    const session: Session = { version: 1, messages: [] }
    await expect(new Agent(session, {
      env: f.env, providers, selection: { ...selection, reasoning: 'default' },
    }).turn('hi', () => {})).rejects.toThrow('Unknown failure')
    expect(session.messages.find((m) => m.type === 'custom_tool_call')?.name).toBe('edit')
    expect(session.messages.at(-1)?.output).toBe('Edited')
    expect(JSON.stringify(session)).not.toContain('PRIVATE-')
  } finally { await f.cleanup() }
})

test('OpenCode incomplete final step and timeouts fail without replaying completed tools', async () => {
  const f = await fixture(`await Bun.stdin.text(); ${event(tool)} ${event({ type: 'step_finish', part: { id: 'finish', reason: 'tool-calls' } })}`)
  try {
    const session: Session = { version: 1, messages: [] }
    await expect(new Agent(session, { env: f.env, providers, selection }).turn('hi', () => {})).rejects.toThrow('Incomplete provider response')
    expect(session.messages.at(-1)?.output).toBe('/workspace')
    await writeFile(f.executable, `#!${process.execPath}\nawait Bun.stdin.text(); await Bun.sleep(30000)\n`, { mode: 0o700 })
    const start = Date.now()
    await expect(new Agent({ version: 1, messages: [] }, {
      env: f.env, providers, selection, requestTimeoutMs: 100,
    }).turn('hi', () => {})).rejects.toThrow('Request timed out')
    expect(Date.now() - start).toBeLessThan(3000)
  } finally { await f.cleanup() }
})
