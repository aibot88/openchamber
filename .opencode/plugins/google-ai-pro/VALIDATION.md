# Gemini provider validation

Version 0.2.1 was tested on macOS arm64 with OpenChamber 2.2.0 and its bundled
OpenCode 2.0.25 on 2026-10-11. The fork's application dependency pins are unchanged.
Other OpenCode versions and operating systems require their own runtime checks.

## Passed checks

- `bun test`: 123 passed, 0 failed across 8 files.
- `bun run type-check`.
- Syntax check of the generated Node bundle.
- Isolated OpenCode runtime probe with provider and OAuth registration, both model
  IDs and their variants, and persisted history during A -> Pro -> Flash -> A.
- Isolated agent loop during A -> Pro/high -> Flash/medium -> A. OpenCode executes
  each fixture tool once and retains both results across model switches.
- 3 subscription-shaped agent-loop requests, including HTTP/1.1 framing and gzip
  inside the real OpenCode host. An independent fixture backend recursively
  checks 39 emitted tool declarations.
- The host emits `exclusiveMinimum` in the original positive-limit declaration;
  the subscription adapter retains it as a description hint. Tool argument fields
  named `exclusiveMinimum`, `title`, `format` and `default` retain their values.
- Account/project/endpoint-isolated catalogs, variant routing, schema-only
  conversion, cancellation, stream failures and rejected API billing destinations.
- Synthetic OAuth callbacks, PKCE/state validation, token refresh, project lookup
  and bounded managed-project initialization.

All automated Google responses and credentials are synthetic. The tests send
0 Google model requests and use isolated homes, configurations and databases.
The fixture schema validator checks a conservative subset. Google does not
publish it as an official private-endpoint validator.

## Fork packaging checks

The imported plugin passes the same 123 tests, its separate type-check and both
OpenCode 2.0.25 runtime probes in its new repository directory. Production
modules retain their original contents. Probe scripts accept portable temporary
directories, select an OpenCode binary and report its actual version.

The repository's pre-commit script previously tried to parse oxlint's
`No files found to lint` prefix as JSON when every changed source file was under
the existing `.opencode/` ignore rule. The script now requires the accompanying
zero-file, zero-diagnostic JSON report. Missing reports, inconsistent counts,
signals, spawn failures and unexpected exits still fail the check. Lint rules,
ignore patterns and finding limits are unchanged.

`node --test scripts/check-changed.test.mjs` passes 10 tests, including a real
oxlint run on a temporary ignored source file. Run `bun run check:changed` at the
repository root before committing. Its workspace checks are separate from this
plugin's tests and type-check.

## Real-account observations

An earlier implementation reached Google and received a license rejection
with code `#3501`. Its inference endpoint and client identification differed
from the pinned reference implementations. Version 0.2.0 corrects those
differences and adds account-specific model discovery.

A later real request reached schema validation and failed because several tool
properties contained `exclusiveMinimum`. The old adapter passed through keywords
missing from its deletion list, and the old fixture server accepted arbitrary
schemas. The expanded schema tests caught 41 failures with that adapter.
Version 0.2.1 constructs an allowlisted schema and adds strict fixture checks.

These observations establish the failed stages only. They do not establish
successful generation or prove that licensing and quota checks will pass.

## Checks still required

- Real Google inference for each selected model and variant.
- Real token refresh and managed onboarding when the account needs them.
- Live A -> Gemini -> A tool-driven continuation and signature compatibility.
- Quota behavior and private endpoint availability.
- Runtime checks on other OpenCode versions, Windows, Linux, VS Code and remote
  deployments. Mobile clients use the connected server's OpenCode process.

## Reproduce the local checks

Run from this plugin directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run type-check
bun run probe:runtime
bun run probe:continuation
```

On macOS the probes default to OpenChamber's bundled CLI. On other systems they
use `opencode` from PATH. Set `OPENCODE_BIN` to choose an OpenCode 2 binary, and
`PROBE_TMPDIR` to choose a temporary directory. Both probes report the selected
CLI's actual version and reject OpenCode 1.

`PROBE_PLUGIN_DIRECTORY` selects the runtime probe's plugin directory.
`PROBE_PLUGIN_ENTRY` selects the continuation probe's module entrypoint. These
options affect test loading only; the production transport has fixed endpoint
allowlists and accepts no endpoint override from environment or configuration.
