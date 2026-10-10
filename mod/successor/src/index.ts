import { recoverAttempts, diagnosticSummary, DiagnosticError, advice } from './diagnostics.ts'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Agent, Session, recover, save } from './agent.ts'
import { ChatGPTAuth } from './chatgpt-auth.ts'
import { chatgptModels } from './chatgpt.ts'
import { discoverModels } from './model-discovery.ts'
import { loadProviders, defaultSelection, validateSelection, catalog, type Selection } from './providers.ts'

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { provider: { type: 'string' }, model: { type: 'string' }, reasoning: { type: 'string' }, speed: { type: 'string' } },
  })
  const providers = await loadProviders()
  const path = resolve(process.env.SESSION_FILE ?? 'session.json')
  // CLI credentials are separate from web credentials: one CLI per auth directory.
  const chatgpt = await ChatGPTAuth.open(resolve(process.env.CLI_AUTH_DIR ?? path + '.auth'))
  const file = Bun.file(path)
  const session: Session = (await file.exists())
    ? Session.parse(await file.json())
    : { version: 1, messages: [] }
  const wantedProvider = values.provider ?? session.selection?.provider ?? process.env.AI_PROVIDER ?? 'openai-chatgpt'
  const providerForDiscovery = providers.find((provider) => provider.id === wantedProvider)
  if (providerForDiscovery?.protocol === 'chatgpt' && chatgpt.status().connected)
    providerForDiscovery.models = await chatgptModels(chatgpt)
  else if (providerForDiscovery && ['responses', 'chat', 'anthropic'].includes(providerForDiscovery.protocol))
    providerForDiscovery.models = await discoverModels(providerForDiscovery)
  session.selection ??= defaultSelection(providers)
  if (values.provider || values.model || values.reasoning || values.speed) {
    const provider = values.provider ?? session.selection.provider
    session.selection = validateSelection({
      provider,
      model: values.model ?? (provider === session.selection.provider ? session.selection.model : providers.find((p) => p.id === provider)?.models[0]?.id),
      reasoning: values.reasoning ?? 'default',
      serviceTier: values.speed ?? 'auto',
    }, providers).selection
  }
  recover(session)
  recoverAttempts(session)
  await save(path, session)
  const agent = new Agent(session, { providers, chatgpt, checkpoint: (s) => save(path, s),
    progress: (a) => console.error(
      "[" + a.status + " · " + a.phase + " · " + Math.floor(a.elapsedMs / 1000) + "s · round " + a.round + " · tools " + a.toolsCompleted + "]",
    ),
  })
  const settings = () => {
    const s = session.selection!
    console.log(`Provider: ${s.provider} | Model: ${s.model} | Reasoning: ${s.reasoning} | Speed: ${!s.serviceTier || s.serviceTier === 'default' ? 'auto' : s.serviceTier}`)
  }
  console.log(
    `Minimal successor | ${path}\nLocal shell enabled. /exit; /retry; /diagnostics; /providers; /settings; /provider <id>; /model <id>; /reasoning <level|default>; /speed <auto|standard|tier>; /connect-chatgpt; /chatgpt; /disconnect-chatgpt.`,
  )
  settings()
  while (true) {
    const input = prompt('you> ')
    if (input === null || input.trim() === '/exit') break
    if (!input.trim()) continue
    try {
      const [cmd, arg, ...extra] = input.trim().split(/\s+/)
      if (cmd === '/connect-chatgpt') {
        const status = await chatgpt.start()
        if (status.pending) console.log(`Open ${status.pending.url} and enter ${status.pending.code}.
Only approve this login if you initiated it here. The OpenAI screen may call this Codex.`)
        while (chatgpt.status().pending) await Bun.sleep(1000)
        const done = chatgpt.status()
        if (!done.connected) throw new Error(done.error ?? 'ChatGPT login was not completed.')
        console.log(`ChatGPT connected (${done.account}). No API key or external agent required.`)
        try {
          const provider = providers.find((p) => p.protocol === 'chatgpt')
          const models = await chatgptModels(chatgpt)
          if (provider) provider.models = models
        } catch { console.log('Model discovery unavailable; this provider cannot be used.') }
        continue
      }
      if (cmd === '/disconnect-chatgpt') { await chatgpt.disconnect(); console.log('ChatGPT credentials removed locally.'); continue }
      if (cmd === '/chatgpt') {
        const status = chatgpt.status()
        console.log(status.connected ? `ChatGPT connected (${status.account})` : status.error ?? 'ChatGPT not connected. Use /connect-chatgpt.')
        continue
      }
      if (cmd === '/providers') {
        for (const p of catalog(providers, process.env, chatgpt.status().connected)) {
          console.log(`${p.id}: ${p.label}${p.unavailable ? ` — ${p.unavailable}` : ''}`)
          if (p.note) console.log(`  ${p.note}`)
          for (const m of p.models) console.log(`  ${m.id} (reasoning: ${['default', ...m.reasoning].join(', ')}; speed: ${['auto', 'standard', ...(m.serviceTiers ?? []).map((tier) => tier.id)].join(', ')})`)
        }
        continue
      }
      if (cmd === '/diagnostics') { console.log(JSON.stringify((session.diagnostics ?? []).map(diagnosticSummary), null, 2)); continue }
      if (cmd === '/settings') { settings(); continue }
      if (['/provider', '/model', '/reasoning', '/speed'].includes(cmd!)) {
        if (!arg || extra.length) throw new Error(`Usage: ${cmd} <value>`)
        let next: Selection = { ...session.selection! }
        if (cmd === '/provider') {
          const provider = providers.find((p) => p.id === arg)
          if (!provider) throw new Error('Unknown provider; use /providers.')
          next = { provider: arg, model: provider.models[0]!.id, reasoning: 'default', serviceTier: 'auto' }
        } else if (cmd === '/model') next = { ...next, model: arg, reasoning: 'default', serviceTier: 'auto' }
        else if (cmd === '/reasoning') next.reasoning = arg
        else next.serviceTier = arg as Selection['serviceTier']
        session.selection = validateSelection(next, providers).selection
        await save(path, session)
        settings()
        continue
      }
      if (input.startsWith('/') && input.trim() !== '/retry') throw new Error('Unknown command. Use /providers or /settings.')
      await agent.turn(input.trim() === '/retry' ? undefined : input, (text) =>
        console.log(`\n${text}\n`),
      )
    } catch (error) {
      // Do not replay commands whose outcomes are uncertain.
      console.error(error instanceof DiagnosticError ? advice[error.category] : 'Command failed. Check configuration and input; private exception details were omitted.')
      recover(session)
      await save(path, session)
    }
  }
  await chatgpt.close()
}

if (import.meta.main) {
  main().catch((error) => {
    // Config/validation errors may include private file contents.
    console.error(error instanceof DiagnosticError ? advice[error.category] : 'Invalid configuration or storage unavailable; private exception details were omitted.')
    process.exitCode = 1
  })
}
