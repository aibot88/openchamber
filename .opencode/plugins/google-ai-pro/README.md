# Google AI Pro subscription provider for OpenCode 2

Version 0.2.1 adds an experimental Antigravity OAuth provider to OpenCode 2.
OpenChamber displays it as `Google AI Pro (unofficial)` and retains the existing
session when the user switches A -> Gemini -> A. OpenCode owns history, tool
execution and permissions. The application packages in this fork are unchanged.

Google's [Antigravity terms](https://antigravity.google/terms), clause 6, prohibit
third-party subscription access. This provider may cause account suspension.
Google has not approved it. Real Google inference remains unverified.

## Install from this fork

Clone the `feat/google-ai-pro-subscription` branch, then run from the repository
root:

```sh
cd .opencode/plugins/google-ai-pro
bun install --frozen-lockfile --ignore-scripts
```

OpenCode discovers this directory as a project-local plugin for sessions in the
fork. Install the plugin's dependencies separately from the app's workspaces.
Its dependency pins match the tested OpenCode 2.0.25 runtime.

To use the same source in other projects, add its absolute directory to the
`plugins` array in your global `~/.config/opencode/opencode.jsonc`. Preserve
existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/openchamber/.opencode/plugins/google-ai-pro"],
}
```

Load one copy of the adapter. If a previous copy is installed globally, use that
copy or replace its configuration before loading this one. Reload OpenCode or
restart OpenChamber after changing plugin configuration.

## Connect and select a model

In OpenChamber provider settings, connect `Google AI Pro (unofficial)`, choose
the subscription OAuth method, and finish browser sign-in on the machine running
OpenCode. A loopback callback on port 51121 receives the code. Sign-in uses PKCE
and state validation and times out after 5 minutes.

OpenCode stores and refreshes this connection. Existing CLI credentials are not
read. If port 51121 is occupied, close the competing sign-in attempt. A remote
browser OAuth flow is unsupported.

Select either model in the existing conversation:

| Selectable model ID | Thinking variants | Default |
| --- | --- | --- |
| `google-ai-pro/gemini-3.1-pro` | low, high | low |
| `google-ai-pro/gemini-3.8-flash` | low, medium, high | medium |

Actual backend routes come from the selected account's `fetchAvailableModels`
catalog. Pro/high may route to `gemini-pro-agent`; Flash may route to
`gemini-3.8-flash-{low,medium,high}`. A route or alias is used only when the
account catalog reports it. The adapter stops if the selected variant is absent.

Catalog caches are isolated by account, project and endpoint. Before discovery,
model labels include `catalog not verified`. Discovery failure blocks dispatch;
an empty catalog disables the models. Discovery does not establish inference
permission or available quota.

Thinking budgets follow the pinned CortexKit implementation. Pro uses 1001 and
10001; Flash uses 1000, 4000 and -1. Context and output limits remain conservative
at 200,000 and 32,000 tokens until live validation.

## Project initialization

Sign-in queries the account's project. It can initialize a managed project only
when Google explicitly reports an allowed managed tier. It submits initialization
once and reads a pending operation at most 10 times within 60 seconds.

It stops when Google requires account verification, acceptance of service notices,
or a user-owned Cloud project. It does not guess project IDs, accept terms, create
a billing project or select a different tier around a rejection. Canceling a
submitted initialization cannot undo remote work that Google already accepted.

## Requests, schemas and session history

Project lookup uses `cloudcode-pa.googleapis.com`. Model discovery and inference
use only `daily-cloudcode-pa.googleapis.com`. The pinned Hub identification is
`antigravity/hub/2.9.1` plus the host platform and architecture; onboarding appends
`google-api-nodejs-client/10.3.0`.

Native requests pass through a loopback bridge bound to `127.0.0.1`. It uses
expiring one-use random tickets and sends only `{}` on the local hop. OAuth and
conversation data stay in memory. Node verifies TLS, sends HTTP/1.1 with ordered
headers and chunked streaming requests, decodes gzip and propagates cancellation.
This implementation does not claim an exact official-client TLS fingerprint.

HTTP(S) CONNECT proxies are supported. When a proxy is configured, `NO_PROXY`
must include `127.0.0.1`. Unsupported proxy schemes stop the request.

The adapter normalizes tool and response schema subtrees. It constructs a
conservative protobuf field allowlist. Unsupported bounds, lengths, patterns,
formats and tool enum/const values become description hints. It inlines local
references, merges compatible intersections and projects unions and tuples with
their alternatives retained as hints. Invalid, recursive, external, dynamic or
conflicting schemas fail locally.

These hints are not full JSON Schema enforcement by Google. Original tool
definitions and tool-specific validation stay intact. Tool arguments, results,
IDs, signatures, system instructions and message history are not cleaned.
OpenCode's normal context compaction and model context limits still apply.

Authentication, quota and network failures stop inference. The adapter does not
retry inference, rotate accounts, switch models or use a paid API fallback.
Choose another provider manually in the same conversation when needed.

## Runtime and policy scope

This is a user-installed OpenCode provider. It does not add OpenChamber server
routes or modify the app's enterprise policy. Enterprise mode keeps provider
connection controls blocked, and OpenCode's `provider.use` policy remains the
authority for provider access. An administrator must approve the plugin and
`google-ai-pro` before it is used in a managed environment.

The adapter runs in the OpenCode process hosting the session. Mobile and remote
clients use that process through the app's existing connection. Only the local
macOS desktop runtime has been tested; other deployments need their own checks.

## Validation and sources

Run from this directory:

```sh
bun test
bun run type-check
bun run probe:runtime
bun run probe:continuation
```

The unit suite has 123 passing tests. The continuation probe runs the real
OpenCode 2.0.25 agent loop against synthetic responses and checks 39 emitted tool
declarations. Each fixture tool executes once, both results survive the model
switches, and the tests send 0 Google model requests. See [VALIDATION.md](VALIDATION.md)
for the failed real-account stages and checks still required.

The Gemini-only code adapts MIT-licensed CLIProxyAPI and CortexKit implementations.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records pinned commits, source
files and license text. The OAuth dependency supplies only public desktop-client
constants; its V1 plugin, account pool and fallback code are not loaded.

## Disable

Add `-opencode.provider.google-ai-pro-subscription` after existing plugin entries
in OpenCode configuration. For a global directory entry, remove that entry when
you stop using the plugin. Conversation history and other provider connections
are unchanged.
