# Third-Party Notices

Exact installed dependency versions and transitive packages are recorded in `package-lock.json` and the generated SPDX SBOM.

| Component | Version or pin | License | Role |
|---|---|---|---|
| MuPDF npm package | 1.27.0 | AGPL-3.0-or-later | PDF parsing and rendering, including native or WASM artifacts |
| PDF.js | 5.5.207 | Apache-2.0 | Structure, text, annotation, and fallback extraction |
| MCP server and core packages | 2.4.0 | Apache-2.0 | MCP server and protocol implementation |
| Zod | 4.6.7 | MIT | Input and output schemas |
| `@napi-rs/canvas` | 0.1.97 | MIT | Optional native rendering support |
| Tesseract | external 5.x | Apache-2.0 | Optional local OCR executable, not bundled by npm |
| Transformers.js | optional peer 4.2.0 | Apache-2.0 | Explicitly installed semantic retrieval runtime |
| all-MiniLM-L6-v2 ONNX model and tokenizer | exact commit in [`docs/SEMANTIC-MODEL.md`](docs/SEMANTIC-MODEL.md) | Apache-2.0 | Optional local embeddings |
| MCPB CLI | 2.1.2 | MIT | Development-only package validation and bundling |
| Synthetic fixtures | generated | CC0-1.0 | Tests and benchmarks |

The MCPB development tool uses patched `tmp`, `node-forge`, and Zod versions through npm overrides. The tool itself is omitted from production npm and MCPB contents.

Download the [Corresponding Source for the MuPDF 1.27.0 WASM](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/download/v3.1.0/mupdf-1.27.0-corresponding-source.tar.gz) from the [v3.1.0 release](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/tag/v3.1.0). The archive includes Artifex's license, WASM build instructions, and bundled build dependencies. The PDF Decompiler source is available under the same release tag.
