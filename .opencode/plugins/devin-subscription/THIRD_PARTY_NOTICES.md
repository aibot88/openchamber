# Third-party sources

The Connect-RPC wire layout and streaming implementation refer to
[dwgx/WindsurfAPI](https://github.com/dwgx/WindsurfAPI), commit
`ee4347224fca2ab330a76fae2acabf24c920367d`. Relevant files are
`src/devin-connect.js`, `src/devin-connect-catalog.js`, `src/connect.js` and
`src/proto.js`. Upstream code was downloaded for review and was not executed.
This adapter excludes account rotation, automatic retries, Language Server
startup, prompt rewriting, MCP-gate neutralization and guessed billing tags.

The loopback bridge follows this fork's Google AI Pro bridge, whose original
architecture comes from CortexKit antigravity-auth, commit
`87d3b14e5881615281151810744f892c4a72e5e4`. Node handles verified TLS and HTTP/1.1.
This adapter does not reproduce an official client's TLS fingerprint.

The build bundles the existing locked OpenCode plugin SDK, Zod and
https-proxy-agent with their used dependencies. `dist/licenses` contains the
original license files for each dependency named by Bun's build report. The
bundled plugin loads without installing dependencies beside it.

The OpenCode SDK packages are pinned to 2.0.25. Their npm archives omit the
license file; `LICENSE.OpenCode.txt` retains the MIT license from the
[matching source tag](https://github.com/anomalyco/opencode/blob/v2.0.25/LICENSE).

## Desktop storage references

The locally installed Devin Desktop 1.126.0 declares Electron 42.2.0. Its public
extension code writes an array of sessions under `windsurf_auth.sessions` for
extension `codeium.windsurf`. The adapter reads only that exact entry.

[Electron 42.2.0](https://github.com/electron/electron/blob/v42.2.0/shell/browser/electron_browser_main_parts.cc)
sets the macOS Safe Storage service to the application name plus ` Safe Storage`
and the account to the application name. This stock implementation does not
establish the account name used by Devin's packaged desktop.

The installed app's public `Resources/app/out/main.js` migration code reads and
writes service `${name} Safe Storage` with account `${name} Key`, using its
`nameLong` product metadata. The user confirmed the nonsecret attributes of the
actual login-keychain item on 2026-10-14. The exact lookup is service
`Devin Safe Storage`, account `Devin Key`. Version 0.1.0 incorrectly used the
stock account name `Devin`; version 0.1.1 corrects it. No older Windsurf name,
stock account name or other Keychain fallback is used. No password was shown
in the user's metadata screenshot or read by the assistant.

[Chromium's macOS OSCrypt](https://github.com/chromium/chromium/blob/148.0.7778.100/components/os_crypt/sync/os_crypt_mac.mm)
documents the `v10` prefix, PBKDF2-HMAC-SHA1 with salt `saltysalt`, 1003 iterations,
16-byte key, AES-128-CBC and a 16-space IV. The interoperable importer uses Node
crypto. Desktop session data and Keychain passwords were not inspected while
developing or testing it. Import testing uses synthetic ciphertext and passwords.

## MIT notices

WindsurfAPI: Copyright (c) 2026 dwgx

CortexKit core and OpenCode adapter: Copyright (c) 2025 Jens

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
