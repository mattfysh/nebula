import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, recover, type Session } from './agent.ts'
import { builtins } from './providers.ts'

async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), 'successor-codex-'))
  await writeFile(join(directory, 'codex'), `#!/bin/bash\n${script}\n`, { mode: 0o700 })
  return {
    env: { PATH: `${directory}:${process.env.PATH}`, ENABLE_CODEX_SUBSCRIPTION: '1',
      OPENAI_API_KEY: 'not-for-codex', CODEX_API_KEY: 'not-for-codex' },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
const selection = { provider: 'openai-subscription', model: 'gpt-5.2-codex', reasoning: 'high' }
test('subscription uses official CLI boundary, no API keys, explicit sandbox/effort and portable context', async () => {
  const f = await fixture(`
[[ -z "\${OPENAI_API_KEY+x}" && -z "\${CODEX_API_KEY+x}" ]] || exit 2
[[ "$*" == *'--sandbox workspace-write'* && "$*" == *'forced_login_method="chatgpt"'* && "$*" == *'model_reasoning_effort="high"'* ]] || exit 3
prompt=$(cat)
[[ "$prompt" == *'remember me'* && "$prompt" != *'private-opaque'* ]] || exit 4
echo '{"type":"item.started","item":{"id":"cmd1","type":"command_execution","command":"pwd"}}'
echo '{"type":"item.completed","item":{"id":"cmd1","type":"command_execution","command":"pwd","aggregated_output":"/workspace","exit_code":0}}'
echo '{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"Done"}}'
echo '{"type":"turn.completed"}'
`)
  try {
    const session: Session = { version: 1, messages: [
      { role: 'user', content: 'remember me' }, { type: 'reasoning', encrypted_content: 'private-opaque' },
    ] }
    const text: string[] = []
    await new Agent(session, {
      env: f.env, providers: builtins({}), selection,
      fetch: async () => { throw new Error('Must not use API') },
      run: async () => { throw new Error('Must not execute CLI commands again') },
    }).turn('continue', (s) => text.push(s))
    expect(text).toEqual(['Done'])
    expect(session.messages.some((m) => m.type === 'custom_tool_call' && m.input === 'pwd')).toBe(true)
    expect(session.messages.some((m) => m.type === 'custom_tool_call_output' && String(m.output).includes('/workspace'))).toBe(true)
    expect(session.messages.some((m) => m.encrypted_content === 'private-opaque')).toBe(true)
  } finally { await f.cleanup() }
})
test('CLI failure retains uncertain calls without exposing raw auth errors; timeout kills process', async () => {
  const f = await fixture(`
cat >/dev/null
echo '{"type":"item.started","item":{"id":"cmd1","type":"command_execution","command":"maybe-ran"}}'
echo '{"type":"error","message":"PRIVATE-AUTH-ERROR"}'
echo 'PRIVATE-STDERR' >&2
exit 1
`)
  try {
    const session: Session = { version: 1, messages: [] }
    await expect(new Agent(session, { env: f.env, providers: builtins({}), selection }).turn('hi', () => {})).rejects.toThrow('Unknown failure')
    expect(JSON.stringify(session)).not.toContain('PRIVATE-')
    recover(session)
    expect(session.messages.at(-1)?.output).toContain('may have run')
    await writeFile(join(f.env.PATH.split(':')[0]!, 'codex'), '#!/bin/bash\ncat >/dev/null\nsleep 30\n', { mode: 0o700 })
    const start = Date.now()
    await expect(new Agent({ version: 1, messages: [] }, {
      env: f.env, providers: builtins({}), selection, requestTimeoutMs: 100,
    }).turn('hi', () => {})).rejects.toThrow('Request timed out')
    expect(Date.now() - start).toBeLessThan(3000)
  } finally { await f.cleanup() }
})
