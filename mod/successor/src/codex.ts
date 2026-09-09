import { cliEventError } from './diagnostics.ts'
import { jsonCli, cliPrompt, type CliTurnOptions } from './cli-process.ts'

// Only the official CLI owns subscription authentication. Never read its token files.
export async function codexTurn(options: CliTurnOptions) {
  const args = ['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '-m', options.selection.model,
    '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"']
  if (options.selection.reasoning !== 'default')
    args.push('-c', `model_reasoning_effort=${JSON.stringify(options.selection.reasoning)}`)
  args.push('-')
  const env = { ...(options.env ?? process.env) }
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  let completed = false
  const started = new Map<string, string>()
  const event = async (e: any) => {
    if (e.type === 'turn.failed' || e.type === 'error') throw cliEventError(e.error)
    if (e.type === 'turn.started') await options.round?.()
    if (e.type === 'turn.completed') completed = true
    const item = e.item
    if (!item || typeof item.id !== 'string') return
    if (item.type === 'command_execution' && ['item.started', 'item.completed'].includes(e.type)) {
      if (!started.has(item.id)) {
        const id = crypto.randomUUID()
        started.set(item.id, id)
        await options.emit({ type: 'custom_tool_call', name: 'bash', input: String(item.command ?? ''), call_id: id })
      }
      if (e.type === 'item.completed') {
        await options.emit({ type: 'custom_tool_call_output', call_id: started.get(item.id),
          output: String(item.aggregated_output ?? '').slice(0, 32768) + `\n\nexit code: ${item.exit_code ?? 'unknown'}` })
      }
    }
    if (e.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string')
      await options.emit({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] })
  }
  await jsonCli({
    executable: 'codex', args, env, prompt: cliPrompt(options), timeoutMs: options.timeoutMs,
    event, complete: () => completed,
    error: 'Codex turn failed or was interrupted. Check official CLI login/configuration. Commands may have run; history retained.',
  })
}
