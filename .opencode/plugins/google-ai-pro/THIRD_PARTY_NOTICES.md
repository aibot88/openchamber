# Third-party sources

This Gemini-only OpenCode 2 adapter is adapted from two MIT-licensed projects:

- **CLIProxyAPI**, commit `f1d4a94ef4398349716f2db5bbc3a27624c174a7`
  (2026-10-11): `internal/misc/antigravity_version.go`,
  `internal/runtime/executor/antigravity_executor_request.go`,
   `sdk/cliproxy/antigravity_models.go`, `internal/util/gemini_schema.go`.
  <https://github.com/router-for-me/CLIProxyAPI>
   Used for service-tier routing, Hub identity, request envelopes, model discovery
   and private subscription schema policies (constraint/enum hints, union
   projection and separate tool/response handling).
- **CortexKit antigravity-auth**, commit `87d3b14e5881615281151810744f892c4a72e5e4`
  (2026-10-10): `packages/core/src/agy-transport.ts`,
  `packages/core/src/model-registry.ts`, `packages/core/src/transform/model-resolver.ts`,
  `packages/core/src/transform/gemini.ts`, `packages/opencode/src/ga/server/index.ts`.
  <https://github.com/cortexkit/antigravity-auth>
  Used for the V2 loopback bridge architecture, HTTP/1.1 request framing,
  schema normalization and same-family route/budget mapping.

The transport uses Node's verified TLS and HTTP parser, not CortexKit's handwritten
HTTP parser. It does not claim to reproduce an official client's TLS fingerprint.
No account rotation, randomized fingerprint regeneration, Claude/GPT route,
Gemini CLI quota fallback, fixed-project fallback, or billing fallback is included.

## CLIProxyAPI license

MIT License

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## CortexKit core and OpenCode adapter license

MIT License

Copyright (c) 2025 Jens

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

OAuth public desktop-client constants are still imported from the pinned
MIT-licensed `opencode-antigravity-auth-updated@1.7.0`; its V1 plugin never runs.
The installed dependency retains its original LICENSE. `https-proxy-agent@7.0.6`
is MIT-licensed and retains its license with the deployed dependency.
