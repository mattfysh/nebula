# Minimal successor

A Bun assistant with a terminal CLI, a small responsive web interface, and one
local `bash` tool. No frontend framework, build step, database service, or new
runtime package dependency. The wrapper improves interaction, not model weights.

## Web / remote access

```sh
bun install
# Supply a provider API key through the environment or a private .env (see below).
bun run remote
```

This starts the loopback-only web server and an outbound Cloudflare quick tunnel.
Open the `https://….trycloudflare.com` URL printed by cloudflared on any device.
**No inbound container port needs to be exposed.** Outbound HTTPS and Cloudflare's
TCP port 7844 must be allowed. The optional tunnel script downloads Cloudflare's
Linux ARM64/AMD64 binary from its official release and verifies GitHub's published
SHA-256 asset digest. TLS verification stays enabled; a local CA bundle is built
from Bun's roots and locally installed certificates for minimal containers.

To sign in, read the generated credential **in your own terminal**, not a chat:

```sh
cat web-data/access-token
# Or, from a Docker host:
docker exec <container-name> cat /code/mod/successor/web-data/access-token
```

Paste it into the login screen; use the same token on your other devices. Treat
it as a remote-shell credential. It is not a provider API key. API keys stay on
the server. Do not place the token in URLs, logs, source control, or screenshots.

Separate commands are available for an existing private reverse proxy:

```sh
bun run web       # http://127.0.0.1:3000, process-level exclusive data lock
bun run tunnel    # optional tunnel to that server
```

`WEB_PORT` defaults to `3000`; `WEB_DATA_DIR` defaults to `web-data`.
`OPENAI_MODEL` defaults to `gpt-6-astra` for backward compatibility; select a model your account supports. Start from this project directory.
Use `bun run web` or `bun run remote`, not the raw web entry point: the scripts
hold an OS lock to prevent two servers from modifying the same data directory.

### Interaction

- Create, rename, and switch among independent, persistently saved conversations.
- Responsive phone/tablet/desktop layout; plain-text replies and code.
- Expandable bash commands and outputs; queued/running/error status.
- Send with the button or Ctrl/⌘+Enter; Enter alone inserts a newline.
- Drafts survive switching in the current tab, not page reloads.
- Turns are server-owned: changing conversations, reconnecting, or closing the
  browser does not cancel them. Changes appear through 1.5-second polling at
  response/tool checkpoints, **not token-by-token streaming**.
- Turns across conversations run one at a time to avoid concurrent shell
  execution. Duplicate submissions while a conversation is busy return 409.
- Errors retain history and enable Retry. On server restart, queued/running
  turns become interrupted; they are never automatically replayed. Review
  history before retrying, especially after uncertain command execution.
- On first startup, an existing `SESSION_FILE` (default `session.json`) is
  imported as an independent snapshot. The live CLI session is never modified.
  This is not live synchronization between the CLI and web histories.

### Work queue

Open **Work queue** in the sidebar to plan work independently of conversations.
Add a title, description/requirements, and notes. Use **Move up / Move down** to
arrange priority (also works on touch devices and with a keyboard), **Edit / notes**
to revise an item, and **Mark done / Reopen** to track completion. Deleting an item
asks for confirmation and removes its notes too.

The queue is a manual planning list: it does not submit prompts or execute work.
Items, order, and completion are saved privately in `WEB_DATA_DIR/work-queue.json`
and shared across your signed-in devices. Unsaved editor text stays when switching
between the queue and chat in this page, but does not survive reloads. Polling
updates the list without replacing your draft. Conflicting saves are rejected;
review the refreshed list before saving your retained draft again. Limits are
1,000 items, 200 characters per title, and 16,000 each for descriptions and notes.

### Security and lifetime

This is a **single-owner remote shell assistant**, not a multi-user hosted service.
Separate conversations isolate model histories, **not files, environment,
permissions, or side effects**. Shell commands run with the container user's
permissions. The assistant does not impose an additional sandbox.

Authentication uses a random 256-bit private token and an HttpOnly, SameSite
cookie (Secure over the HTTPS tunnel). Writes require same-origin JSON.
The app rejects unauthenticated API access, rate-limits login attempts, bounds
request bodies, renders output only as text, and uses a restrictive CSP.
Opaque reasoning is retained for the model but never sent to the browser.
There is no CORS access or public file-serving route for session data.

Conversation JSON and credentials have owner-only permissions; the data
directory is private. Files are saved by atomic rename, not encrypted at rest.
Back up **the entire data directory**, privately. History is not compacted
automatically and can eventually exceed the model's context limit.

Cloudflare terminates HTTPS and can see the web traffic. Quick tunnels have no
uptime guarantee, use a new random URL each launch, and are for temporary use.
The container and host must remain running and online. Detached processes survive
leaving the CLI, **not container shutdown**. For durable use:
1. Preserve `web-data` in a host bind mount or named volume when recreating the
   container (if the project directory is already mounted, it may already persist).
2. Set `bun run remote` as the container/supervisor startup command.
3. Optionally use a named Cloudflare tunnel or a private VPN for a stable address.
   That requires your provider account/configuration; it is not automated here.

Stop foreground services with Ctrl+C. The web server drains active turns; a forced
container stop may interrupt them, which startup recovery handles without replay.
To revoke all browser sessions, stop the server, remove `web-data/access-token`,
then start again and use the newly generated token. Signing out only removes
the current browser's cookie.

## Providers, models, and reasoning

In the web UI, open **Provider, model & reasoning**, choose settings, and click
**Save settings** before sending. Settings are private, persisted per conversation,
and cannot change during a queued/running turn. Other conversations keep their
own settings. Missing credentials and unsupported integrations are marked
unavailable. You can start the web UI/CLI without an OpenAI key.

| Provider | Setup on the server |
| --- | --- |
| OpenAI API | `OPENAI_API_KEY` |
| Claude API | `ANTHROPIC_API_KEY` |
| OpenCode Zen API | `OPENCODE_API_KEY`; built-in profile uses OpenAI-compatible chat completions |
| OpenAI subscription (OpenCode) | OpenCode signed in to OpenAI with ChatGPT, and `ENABLE_OPENCODE_SUBSCRIPTION=1`; **no Codex executable needed** |
| OpenAI subscription (Codex CLI) | Optional alternative: official Codex CLI, `codex login`, and `ENABLE_CODEX_SUBSCRIPTION=1` |
| Claude subscription | Not integrated; use Claude API here |

### OpenAI subscription through OpenCode (no Codex installation)

The **OpenCode Zen (API)** profile and the **OpenAI subscription (OpenCode)**
profile are different routes. OpenCode supports its own OpenAI ChatGPT login;
Codex installation is not a general requirement for subscription access.

On the same server/container and OS account that runs this app:

```sh
opencode auth login
# Select OpenAI, then ChatGPT Plus/Pro (not API key).
# Alternatively, use /connect inside OpenCode.
opencode models openai
```

If OpenCode is already signed in to OpenAI using ChatGPT, skip the login step.
Use a recent OpenCode release with built-in OpenAI subscription authentication
and `run --format json --variant` support. Add to this project's private `.env`:

```dotenv
ENABLE_OPENCODE_SUBSCRIPTION=1
```

Restart the web server with `opencode` on its PATH, then select **OpenAI subscription
(OpenCode)** and **Save settings**. Use the full namespaced model ID shown by
OpenCode, e.g. `openai/gpt-5.2-codex`. The CLI equivalent is:

```text
/provider openai-subscription-opencode
/model openai/gpt-5.2-codex
/reasoning high
```

This invokes `opencode run` with the selected model and maps reasoning to
`--variant`; default reasoning omits that flag. Authentication and token refresh
remain inside OpenCode. The app does not read or copy its credential files.
The child process blanks OpenAI API-key environment variables, sets a non-secret
API-key placeholder in OpenCode's provider configuration to avoid ordinary
saved-key fallback, and enables only the OpenAI provider. Choose ChatGPT login
in OpenCode; an API-key login is not supported by this subscription route.
Existing Codex selections remain unchanged; switch explicitly to use OpenCode.

OpenCode owns its tools, configured permissions, and additional local session
storage. It is **not** the wrapper's bash tool or Codex's sandbox. The wrapper does
not auto-approve additional permissions. Automatic transcript sharing is disabled.
Each turn starts a fresh OpenCode run using visible conversation context; the
wrapper retains completed text/tool events, not private reasoning. Tool events
may arrive only after execution, so interrupted runs may have unrecorded effects.
Review files before retrying. The wrapper's per-command timeout and tool-round
limit do not apply inside OpenCode; the whole invocation has a ten-minute timeout
and an 8 MiB event-output limit. Trust your installed CLI and local configuration.
See [OpenCode's OpenAI provider documentation](https://opencode.ai/docs/providers/#openai).

API usage is billed separately from consumer subscriptions. Codex subscription
access depends on the installed official CLI, your plan, model access, and provider
terms. Install/authenticate it yourself on the server using official instructions;
the app never reads its credential files or implements unofficial OAuth. Codex is
forced to ChatGPT login mode and OpenAI's provider; API-key environment variables
are removed from its child process. Claude subscription tokens are **not** accepted
as API keys; this app does not provide a subscription workaround.

**Codex mode differs from API mode:** it runs `codex exec` with its own tools,
`workspace-write` sandbox and no interactive approvals. It may therefore be unable
to perform operations permitted by this app's unsandboxed API bash tool. Its
commands/results and assistant messages are checkpointed; other internal CLI tool
events are not projected into the transcript. The wrapper's 60-second bash timeout
and 20-tool-round cap do not apply inside Codex; its entire invocation has the
ten-minute timeout and bounded event-output limit. Each turn starts a new CLI
invocation with visible conversation context, not a resumed Codex session.
Do not enable it unless you trust the installed CLI and its local configuration.

Model suggestions are a small editable capability catalog, **not** a live list of
your account's entitlements. Enter any model ID supported by the chosen endpoint.
Unknown models allow only **Provider default** reasoning (no reasoning parameter
is sent). To expose reasoning for additional models, configure their capabilities
below rather than guessing. Known OpenAI/Zen reasoning models send effort; Claude
4.6 uses adaptive thinking/effort, while the configured Claude 4.5 model maps
low/medium/high to 1024/4096/8192 thinking tokens. Reasoning resets to default
when selecting a different provider/model.

Switching providers/models sends prior **visible history**, including labeled tool
context, to the new provider. Opaque reasoning, signatures, and native call IDs are
not forwarded across that boundary. Original history remains in the private
session file, and opaque reasoning is never exposed to the browser. Consider the
new provider's data policies before switching. Same-provider/model API turns retain
native reasoning/tool continuity.

### Defaults and additional providers

`AI_PROVIDER`, `AI_MODEL`, and `AI_REASONING` set defaults for new conversations/
sessions. Existing saved selections win. Legacy `OPENAI_MODEL` is still supported.
For example, use `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` to start with Claude.

Set `PROVIDERS_FILE` to a server-side JSON file containing additional profiles.
Profiles with an existing ID replace that entire built-in profile. Restart after
configuration or credential changes. Supported API protocols are `responses`,
`chat` (OpenAI-compatible chat completions), and `anthropic` (Messages API):

```json
[
  {
    "id": "my-gateway",
    "label": "My OpenAI-compatible gateway",
    "protocol": "chat",
    "baseURL": "https://gateway.example/v1",
    "keyEnv": "GATEWAY_API_KEY",
    "models": [
      { "id": "my-model", "reasoning": ["low", "medium", "high"] },
      { "id": "plain-model", "reasoning": [] }
    ]
  }
]
```

Use the endpoint's exact model IDs and only reasoning levels it documents.
For Claude profiles, set each reasoning model's `reasoningMode` to `adaptive` or
`budget`. For other OpenCode Zen protocols, add a profile with the appropriate
protocol, Zen base URL, and `keyEnv: "OPENCODE_API_KEY"`.
For a local unauthenticated endpoint, omit `keyEnv`. Remote endpoints should use
HTTPS. Credentials belong in server environment variables, **not** in the JSON,
browser, URLs, or session selections. Only trusted administrators should edit
profiles; configured endpoints receive prompts and, when configured, API keys.
No automatic provider/model fallback or paid request retries are performed.

## CLI

```sh
bun start
# Override the saved selection explicitly:
bun start --provider anthropic --model claude-sonnet-4-6 --reasoning high
```

At the prompt:
```text
/providers                 # availability, model suggestions, reasoning levels
/settings                  # current saved selection
/provider openai           # select provider and its first model
/model gpt-5.2             # custom model IDs also accepted
/reasoning high            # or default
```

`SESSION_FILE` defaults to `session.json`. Blank lines are ignored; `/exit` or
EOF exits; `/retry` resumes after an error. Use only one CLI per session file.
The initial history may contain a labeled predecessor summary, not a verbatim
transcript. Subsequent messages and tool results are saved atomically and privately.

The agent has a ten-minute API request timeout, 60-second process-group shell
timeout, 32 KiB retained shell output, and a 20-round tool limit per turn.
Shell output is drained after truncation. Timeout kills ordinary descendants,
not deliberately escaped process groups. There are no automatic API retries.
Already running CLI processes keep their old timeout until restarted.

## Validate

```sh
bun test
bun run check
```

Tests cover provider payloads/capabilities, mocked Codex/OpenCode execution,
settings validation/routing/persistence, provider switches, agent responses/tools,
bounded shell execution, persistence,
authentication/CSRF, isolated histories, serialized turns, conflicting sends,
restart recovery, error handling, and private transcript projection.

Provider tests use mocked HTTP/CLI responses; they do not verify live account access or make paid requests.
