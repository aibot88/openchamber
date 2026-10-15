# Side chat validation

## Hidden-history revision (2026-10-12)

The side chat keeps the fork's model context but renders only messages after
the last cloned record. The marker is persisted before the panel opens or its
first question is sent. Main-column history is unchanged. Old forks without
the marker retain their original full-history view; recreate a side chat from
the intended main session to use the new behavior.

- UI type-check, UI lint, Knip and the final web asset build passed.
- Targeted unit suites passed independently: side-chat metadata (7), fork
  metadata inheritance (11), pinned composer selection (6), message ordering
  (5), session actions (123). Full repository tests and `check:changed` were
  not run. No git commands, commits or PR operations were performed.
- The new side-chat metadata and pinned-selection files pass targeted oxlint.
  Existing anti-slop findings in `ChatContainer.tsx` and message ordering remain
  outside this revision; a repository-wide ratchet comparison was not run.
- Full-web runtime tested in an isolated Chromium window without a preload or
  desktop runtime injection: blank fork view, both columns sending independently,
  draft preservation, closing/reopening, reload, assistant-menu entry and
  `/sidechat <question>`. Evidence: `artifacts/sidechat-native-smoke/web-e2e.json`.
- macOS arm64 final packaged renderer tested at `openchamber-ui://app` with an
  isolated profile and a local fixture provider. The same flow passed, with
  distinct column/session IDs and server-side message ownership verified.
  Evidence: `artifacts/sidechat-native-smoke/native-e2e.json` and
  `artifacts/sidechat-native-smoke/final-independent-columns.png`.
- The fixture provider's actual side-question request contained
  `MAIN_HISTORY_ONLY`, `MAIN_ONLY_AFTER_FORK` and `SIDE_COMMAND_QUESTION`, proving
  model context was retained even though the inherited prompts were hidden.
- Packaged fault injection passed for a 500 on boundary metadata persistence
  and an empty cloned-tail read: no replacement panel, no follow-up prompt,
  unchanged main selection, command text restored. Evidence:
  `artifacts/sidechat-native-smoke/metadata-failure.json` and
  `artifacts/sidechat-native-smoke/boundary-read-failure.json`.
- Fixed a model-change path where the pinned composer inherited the previous
  model's effort. Its regression tests pass. The reported live DeepSeek route
  error was not reproduced against the user's provider; this is not evidence
  that every cause of that error is resolved.
- Final app passes deep/strict signature verification (local ad-hoc signature,
  no notarization) and packaged OpenCode CLI verification (2.0.26).
- The final revision replaced `/Applications/OpenChamber.app`; its installed
  asset hash matches the validated bundle. The running user app was deliberately
  not quit because it owns this session's OpenCode process. Restart is required;
  no user profile/config/session data was changed by installation. See
  `sidechat-installation.json` for the previous-app backup and installed hashes.
- Search filtering and pagination boundary logic have unit coverage through
  the shared chronological filter but were not exercised with the search index
  enabled or a multi-page live transcript. No performance benchmark, HMR desktop
  run, Windows/Linux, VS Code or native-mobile runtime validation was performed
  for this revision. The user stopped the isolated test services after validation.

## Behavior

The assistant answer's branch menu offers "Side chat from here". `/sidechat`
forks after the last completed turn; `/sidechat <question>` also sends that
question to the fork. The main chat stays selected. Each chat has its own
composer, and closing the panel preserves the fork and its draft.

The fork uses the same working directory and normal agent permissions.
The feature uses the existing context-panel chat and its saved placement.
VS Code, mobile, Mini Chat and peek views do not offer the new entry.

## Automated checks

- Fork regression tests: 27 passed. Covers custom column openers, canonical
  directories, unchanged main composer state, creation failure and stale runtime
  responses, including a switch before a follow-up send.
- The full `session-actions.test.ts` file passed all 123 tests.
- Slash command, fork-send recovery and locale tests: 39 passed. Covers a runtime
  switch during a rejected send, with text restored to the original fork identity.
  All 15 locales
  contain translations for the new action, command description and unavailable
  message.
- Workspace type-check and lint passed. UI type-check and lint also passed
  after the implementation changes.
- Dead-code check passed.
- Anti-slop check passed for the new `packages/ui/src/lib/sideChat.ts` helper.
- Production Web build passed. Large-chunk warnings remain.

## Renderer integration

The production UI ran against an isolated OpenChamber server and a local
deterministic model provider. Chromium came from the repository's Electron
dependency, with a separate browser profile, no application preload and no
native bridge. DOM clicks and Chromium text input exercised the rendered UI;
the server's session/message commands checked the resulting transcripts.

- The message menu created a writable fork while keeping the main selection
  and unsent draft.
- A side question reached only the fork. Its transcript retained the source
  prompt, and the source transcript was unchanged.
- A main send reached only the source session and preserved the side draft.
- Closing and reopening the panel preserved the server session and side draft.
- `/sidechat` consumed the command in the main composer and sent its argument
  only to a new fork.
- An Arabic reload restored the fork and mirrored the two chat columns.
- The mobile layout loaded without an uncaught renderer exception.

The renderer checks also passed against the final Web build after the
send-failure runtime identity fix.

![Main and side chat with independent drafts](screenshots/sidechat-validated.png)

## Limits

Packaged Electron startup/auth, native mobile, VS Code, Windows and Linux were
not runtime-tested. The mobile check covers loading, not command execution or
native keyboard behavior. No performance benchmark or full repository test
suite was run. `check:changed` was not run; no commit was requested or made.

The installed OpenChamber app was not replaced. Test sessions used isolated
data and a local fixture provider, with no real conversation or hosted model.

## macOS installation follow-up

The user requested replacement of the installed app after the validation above.
The arm64 desktop bundle built successfully with a local ad-hoc signature and
without notarization. Signature integrity and the bundled OpenCode 2.0.26
verification passed.

An isolated native launch confirmed the `openchamber-ui://` document, desktop
bridge, mounted UI, cleared splash and editable composer. The startup benchmark
itself produced no valid timing result because its recorder missed the initial
document; the separate functional smoke check passed.

The replacement runs in an independent installer after this session's reply.
It stages and verifies the new app, requests normal quit, moves the old app into
`~/Library/Application Support/OpenChamber Backups/`, replaces the installed
bundle and launches it. The installer leaves configuration and session
directories unchanged and writes its status to
[`sidechat-installation.json`](sidechat-installation.json).
