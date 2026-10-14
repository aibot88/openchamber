# Devin subscription provider for OpenCode 2

Experimental, unofficial provider for a personal Devin Desktop subscription.
OpenCode owns the conversation, tools and permissions. No Devin agent, Language
Server or standalone proxy runs. The Google plugin is unchanged. This fork also
adds OpenCode command-authentication buttons to OpenChamber's Providers page.
The locally installed desktop preview includes that UI change.

Nonofficial access may violate Cognition's terms and suspend the account. A model
catalog is not proof of entitlement, available quota or subscription-only billing.
Model calls can incur usage or overage charges under the account's plan. Check
the account's billing settings before any real call.

## Boundaries and validation plan

| Surface | Behavior |
| --- | --- |
| Web | Uses the selected session's OpenCode provider. Desktop import requires a macOS OpenCode host with Devin installed. |
| Electron desktop | Same provider; an explicit connection command imports the local desktop login. |
| VS Code | Same provider on its OpenCode host; no extension-host or renderer credential access. |
| Hosted mobile | Uses the remote OpenCode host, never the phone's storage. |
| Capacitor mobile | Same as hosted mobile; import is unsupported on a non-macOS host. |

The only added listener is a one-use-ticket bridge bound to `127.0.0.1`, inside
the OpenCode process. Only the selected provider receives conversation content.
No app routes, relay contracts, telemetry or enterprise settings are changed.
Enterprise mode keeps the existing connection controls disabled. Administrators
must separately approve this user-installed plugin and `devin-subscription`
through OpenCode's provider policy.

Credential authority is the active OpenCode connection, not the desktop storage.
The desktop record is read only during the explicit import command. OpenCode
then saves an independent copy. Expired credentials require manual reimport;
there is no background desktop read, relogin, credential exchange or account
fallback. Source storage and the macOS Keychain are never modified.

Catalog authority is `GetCliModelConfigs` for the selected connection. Disabled
entries are excluded. Each selector is its own model ID, including tiered entries;
aliases are labels, not routes. There is no model-family guessing or automatic
selection. A successful empty catalog is distinct from discovery failure.
Concurrent discovery is shared per credential, without a periodic poll or a
cross-account cache. Dispatch rechecks the active connection and catalog membership.

Protocol work is bounded: 8 MiB per protobuf/frame, 32 MiB per emitted answer,
at most 1,024 catalog entries and 128 tool calls. Cancellation and disposal release
stream readers, tickets, HTTP requests and connections. No inference is retried.
Tool calls reach OpenCode only after a successful Connect trailer and EOF. Any
upstream stop enum completes the turn (`2`, `3` and `4` are observed clean
completions); truncation surfaces as `length` when reported output tokens reach
the requested cap. Chat requests are sent uncompressed: GetChatMessage answers a
gzip request frame with a generic `internal` trailer error.

Required checks: synthetic encrypted-storage import and refusal cases; byte-level
protobuf/native tools; fragmented and gzip Connect frames; fail-closed trailers;
bridge ticket reuse/abort/disposal; real OpenCode 2 offline A -> Devin model 1 ->
model 2 -> A continuation, with tools executing once. Live account inference,
entitlement, billing, real Keychain access and remote/mobile operation remain
unverified until separately authorized and tested.

## Install and connect

Use this fork's UI for the import button. Installing the provider alone in the
unmodified upstream UI exposes the model catalog after connection, but that UI
does not render command authentication. OpenCode's `/connect` can invoke the same
registered import method without this UI change.

Build from the repository root with the existing locked toolchain:

```sh
cd .opencode/plugins/google-ai-pro
bun install --frozen-lockfile --ignore-scripts
cd ../devin-subscription
ln -s ../google-ai-pro/node_modules node_modules
bun run type-check
bun test
bun run probe:bundle
```

Skip `ln -s` if the link already exists. This installs the build toolchain only;
it performs no OAuth, desktop credential import or model calls.

The source plugin is discovered automatically in this checkout. To use it in
another project, put `dist` in a stable local folder and add that folder to the
global `~/.config/opencode/opencode.json` `plugins` array, preserving existing
entries. Example after placing `dist` at the path shown:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/devin-subscription"]
}
```

Register either the source directory or the bundle, once. The bundle includes its
SDK and runtime dependencies; it needs Bun on the OpenCode host for the import
command. OpenCode 2.0.26 is the tested host version.

1. Sign in to Devin Desktop, then quit it so it saves and closes its database.
2. In Settings > Providers, select `Devin subscription (unofficial)` and connect
   with `Import local Devin Desktop login`. Approve macOS Keychain access only if
   the unofficial-access and billing risks are acceptable.
3. Select the exact `devin-subscription/<catalog-selector>` model in the current
   session. Tiered catalog entries remain separate models. There is no automatic
    model, account or tier selection.

The updated Providers page accepts an optional account name before command
sign-in. To save another account, change the login in Devin Desktop, quit the
app, and choose Add account in OpenChamber. A successful addition becomes active.
Use the saved account's Use button to select it manually, and its menu to rename
or remove it. Each import still accepts exactly one current desktop session.
Saved tokens can expire or be revoked, including after desktop logout; the
offline multi-account tests do not establish real token lifetime. Reimport
explicitly if an account needs authentication.

An active WAL or recovery journal stops the import before any Keychain access.
The importer uses SQLite immutable read-only mode and checks that the source file
did not change during the read. It never checkpoints, recovers or copies the
desktop database. Only the specified login row and the `Devin Safe Storage` /
`Devin Key` Keychain item are used. Keychain denial, unsupported encryption, multiple
sessions or a legacy API key stop the import. Cancel stops the helper process and
its Keychain read. Secret stdout is consumed only by OpenCode's command-auth API.
Do not run `import-command.ts` or its bundle in an agent shell.

Version 0.1.1 corrects the Keychain account name from `Devin` to `Devin Key`.
The installed desktop's public migration code and user-confirmed nonsecret
Keychain attributes establish this exact lookup. Standard Electron naming alone
did not establish the packaged app's account name. No alternate account or service
is tried. A failed 0.1.0 import must be retried explicitly after updating.

There are no background desktop reads. Logout in Devin does not erase OpenCode's
independent credential copy; disconnect this provider in OpenChamber too. Never
paste a token into chat or commit it to configuration. Reimport manually when the
session token expires. The raw key method is for an intentionally supplied Devin
session token, not a paid API key or enterprise authentication flow.

This release accepts text and native function tools. Images, strict tool-schema
enforcement, guessed variants and provider-specific private reasoning carriers
are refused. Tool descriptions and JSON Schema are preserved. If the service
rejects them, the request stops. The native driver's `store: false` field does
not change Devin's retention policy. Version 0.1.2 reads context bounds from
ClientModelConfig field 18 and ModelInfo field 4, using the tighter positive value
when both are reported. ModelInfo field 13 supplies the output limit. Missing or
zero fields remain unknown and are marked in the model name. The adapter does
not substitute an API specification or a model-family default.

The request output cap follows the selected model's reported limit. An explicit
smaller cap is preserved; an explicit larger cap fails locally. If the catalog
does not report an output limit, the adapter leaves an absent cap to the service
and preserves an explicit cap. OpenCode may supply its own per-request budget.
CompletionConfiguration field 3 is `max_newlines`; it is left unset and is never
used for a context size. These are reported metadata values. The service's real
input/rejection boundary and billing remain unverified without live inference.
Neither catalog context field establishes whether output shares that window,
so the adapter does not infer an independent `limit.input` or sum the bounds.
An unknown context window is not a promise of unlimited input; automatic
compaction cannot rely on a service window that has not been reported.

## Validation

The source and bundled providers pass the real OpenCode 2.0.26 offline agent loop:
A -> Devin model 1 -> Devin model 2 -> A in one session. Two host tools each run
once. The probe checks original descriptions, JSON Schema, arguments, call IDs and
results, plus HTTP/1.1, HTTP gzip and Connect gzip. Synthetic encrypted desktop
storage enters the host through command authentication; the client receives no
secret stdout. The bundle probe copies `dist` outside the checkout, loads both
entrypoints in fresh Bun processes without development dependencies, and runs the
agent loop using the copied provider. Account-switch fixtures verify separate
inventories and a refused catalog without retaining another account's choices.
`DEVIN_PROBE_BUNDLE` selects only the probe's build artifact and is
not a production endpoint or credential override.
The 101-test unit suite covers distinct per-account limits, missing/zero limits,
conflicting context bounds, invalid wire fields and outputs above the old 8K cap.
`DEVIN_PROBE_UNKNOWN_LIMITS=1` removes limit metadata from the isolated fixture;
the agent loop still preserves tools and explicit 65,536/16,384 output budgets.
The fixture returns short text, not outputs of those lengths.

For full-page browser acceptance, build the web UI at the repository root with
`bun run build:web`, then run `bun run probe:browser` here. It serves that production
UI on loopback against a separate OpenCode process with temporary HOME, XDG and
OpenChamber data directories. Connect provider > Devin subscription (unofficial)
uses synthetic encrypted storage. It does not import the real desktop account.
Authentication starts only when Connect is clicked. The printed fixture-status URL
reports command starts and model/tool calls without credentials. Stop with Ctrl-C;
the probe writes `browser-report.json` to its printed temporary directory and
stops only the processes it started. The browser mode expires after 20 minutes.
Each run uses a new free loopback port so browser state from earlier fixtures
does not select their old project directories. `DEVIN_PROBE_UI_PORT` fixes that
port when needed; use a fresh browser profile if repeating a fixed-port run.
The synthetic command waits until the fixture is released. POST the JSON string
`"fail"` or `"succeed"` to `/command-control` on the printed fixture-status origin
to test failure or completion, or `"wait"` for another cancellation attempt.
These controls exist only in the offline probe, not in the installed provider.
`DEVIN_PROBE_WEB_PACKAGE` may point to an extracted web package to check its
production UI and server instead of the checkout build. Dependencies for that
web package must already be available; this does not install or deploy it.

Unit tests cover encrypted import, WAL refusal without changing DB/WAL/SHM
bytes, parser bounds, HTTP header/idle/total timeouts, cancellation, native tools, late policy refusal and ticket
reuse. Shared UI tests cover connect, failed/expired status, cancellation before
connect returns, unmount and status cancellation. Enterprise server tests cover
the desktop-import command route's refusal. No real Devin model request, login
decryption, Keychain access, entitlement or billing verification was performed.
Native desktop and remote/mobile operation still need separate live checks.

## Build toolchain

No new library dependencies are added. This fork reuses the already-pinned build
toolchain of `../google-ai-pro` (`@opencode/plugin` 2.0.25, Zod 4.3.6,
`https-proxy-agent` 7.0.6, TypeScript and Bun types). Build output and the local
`node_modules` link are ignored. Third-party source pins and license notices are
in `THIRD_PARTY_NOTICES.md`; `dist/licenses` retains bundled dependency licenses.
