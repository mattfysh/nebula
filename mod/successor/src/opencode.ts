import { cliEventError, DiagnosticError } from './diagnostics.ts'
import { jsonCli, cliPrompt, type CliTurnOptions } from './cli-process.ts'

// Delegate OAuth to OpenCode's built-in OpenAI provider, not the Codex executable
// or Zen API. Never read/copy its stored credentials or implement a token exchange.
export async function opencodeTurn(options: CliTurnOptions) {
  if (!options.selection.model.startsWith('openai/'))
    throw new DiagnosticError('configuration')
  const args = ['run', '--format', 'json', '--model', options.selection.model, '--agent', 'build']
  if (options.selection.reasoning !== 'default') args.push('--variant', options.selection.reasoning)
  const env = { ...(options.env ?? process.env) }
  // Empty values also prevent Bun-backed CLIs from reloading keys from .env.
  env.OPENAI_API_KEY = ''
  env.CODEX_API_KEY = ''
  // Do not share private transcripts even if the user's OpenCode defaults do.
  // A non-secret placeholder blocks ordinary saved API-key fallback; OpenCode's
  // OAuth provider supplies its own fetch/auth when ChatGPT login is configured.
  let configured: Record<string, any>
  try {
    configured = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error()
  } catch { throw new DiagnosticError('configuration') }
  env.OPENCODE_AUTO_SHARE = 'false'
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...configured,
    share: 'disabled', enabled_providers: ['openai'],
    model: options.selection.model, small_model: options.selection.model,
    provider: {
      ...configured.provider,
      openai: {
        ...configured.provider?.openai,
        options: { ...configured.provider?.openai?.options, apiKey: 'subscription-oauth-required' },
      },
    },
  })
  let completed = false
  const seen = new Set<string>()
  await jsonCli({
    executable: 'opencode', args, env, prompt: cliPrompt(options), timeoutMs: options.timeoutMs,
    complete: () => completed,
    error: 'OpenCode turn failed or was interrupted. Check OpenCode OpenAI ChatGPT login, model and CLI configuration. Tools may have run; history retained.',
    event: async (e) => {
      if (e.type === 'error') throw cliEventError(e.error)
      if (e.type === 'step_start') { completed = false; await options.round?.() }
      if (e.type === 'step_finish') completed = e.part?.reason === 'stop'
      const part = e.part
      if (!part || typeof part.id !== 'string' || seen.has(part.id)) return
      if (e.type === 'text' && typeof part.text === 'string') {
        seen.add(part.id)
        await options.emit({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: part.text }] })
      }
      if (e.type === 'tool_use' && typeof part.tool === 'string' && ['completed', 'error'].includes(part.state?.status)) {
        seen.add(part.id)
        const id = crypto.randomUUID(), state = part.state
        const input = part.tool === 'bash' && typeof state.input?.command === 'string'
          ? state.input.command : JSON.stringify(state.input ?? {})
        await options.emit({ type: 'custom_tool_call', name: part.tool, input: input.slice(0, 32768), call_id: id })
        await options.emit({ type: 'custom_tool_call_output', call_id: id,
          output: String(state.status === 'error' ? state.error ?? 'Tool failed' : state.output ?? '').slice(0, 32768) })
      }
      // Reasoning and native IDs never go to the transcript.
    },
  })
}
