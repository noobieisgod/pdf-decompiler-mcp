# Client Compatibility

Launching a process is not sufficient for a compatibility claim. Validation covers tool discovery, input schemas, structured content, compact text fallback, inline images, resource links, large bounded results, cursors, partial decomposition, errors and warnings, shutdown, and protocol-clean stdio.

| Client | Version | Date | Platform | Level | Evidence |
|---|---|---|---|---|---|
| Official MCP TypeScript client | 2.4.0 | 2026-11-28 | Windows build 26200.9974, Node 22.23.5 and 24.14.1 | Automated | Discovery, seven input and output schemas, structured content, bounded Markdown fallback, errors, resources, bounded inline images, cursors, partial work, stdio, and shutdown pass the repository tests |
| MCP Inspector CLI | 2.0.0 | 2026-08-01 | Windows build 26200.8655, Node 24.14.1 | Partial automated | JSON `tools/list` succeeds over stdio and exposes all seven input and output schemas; interactive image, resource, large-result, and shutdown UI behavior is untested |
| 2025-era raw stdio client | Protocol 2025-06-18 | 2026-08-02 | Windows build 26200.8655, Node 22.23.1 and 24.14.1 | Automated | Capability-free initialization, protocol-clean stdout, and clean shutdown pass `test/server-smoke.test.mjs` |
| Claude Desktop | Unavailable | 2026-11-28 | Windows x64 | Untested | The bundle validated and its server ran through Codex, while Claude Desktop installation and UI behavior remain unverified |
| Codex app-server | codex-cli 0.144.4 | 2026-11-28 | Windows build 26200.9974, Node 24.14.1 | Partial automated | The packaged server exposed all seven tool schemas and passed partial extraction, compact Markdown, a bounded continuation, inline PNG, resource read, structured error, and clean shutdown. Desktop UI behavior remains unverified |

`automated` means a repeatable repository test. `manual` means all relevant behaviors were exercised by a person and recorded. `partial` lists the exact subset tested. `untested` makes no compatibility claim.

Before claiming compatibility with a desktop client, record its exact version and date and exercise every behavior in the opening paragraph. Releases can include a verified server and preview bundles for clients whose UI checks are incomplete. Mark the scope and limitations in the release notes.

Windows is the blocking validation platform for this corrective effort. macOS, Linux, and Linux OCR run in a separate best-effort workflow whose badge reports failures independently from Windows CI. No current compatibility claim is made for those platforms until a dated successful matrix is recorded here. Their filesystem, native-memory, locking, packaging, OCR, and stdio behavior remains unverified.

Image behavior is request driven, not inferred from a nonexistent generic client capability. `auto` returns a resource link and text URI. A client profile may explicitly request inline content after that client has been tested.

Inspector 1.0.0 was also attempted on 2026-08-01. Its package emitted an official v1 deprecation notice and the connection closed before discovery, so it is not listed as compatible.
