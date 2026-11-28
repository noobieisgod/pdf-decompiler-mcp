# Licensing and Provenance Review

## Automated findings

- The project metadata and manifest use `AGPL-3.0-only`.
- MuPDF 1.27.0 declares `AGPL-3.0-or-later`, which is compatible with an AGPL distribution but creates Corresponding Source obligations for bundled native or WASM code.
- PDF.js and the optional model family declare Apache-2.0. MCP, Zod, and canvas packages declare permissive licenses.
- Generated fixture source is original programmatic text, geometry, vector content, raster patterns, malformed structures, and deterministic security dictionaries under CC0-1.0.
- The readable OCR raster is rendered with the pinned `LiberationSans-Regular.ttf` distributed in `pdfjs-dist` under its included Liberation font license. The generator records hashes and expected behavior, and package allowlists exclude all test PDFs.
- `npm run license:check` reads every installed package license. `npm run package:verify` generates an SPDX 2.3 SBOM from the isolated production stage.

## Material reviewed

The migration inventory identifies original repository archives, PDFs, and source trees. The 3.0.0 implementation reuses the repository owner's extraction source and adapts official package APIs. No third-party document text is copied into generated synthetic fixtures.

The separate real-world evaluation corpus contains two checked-in PDFs with document-specific licenses and attribution. Medium Test One combines CC BY-SA Wikipedia text, Wikimedia images under the licenses or public-domain claims listed in `evaluation/ATTRIBUTION.md`, project-owned VEXLearn material, and public-domain Declaration of Independence text. Medium Test Two is original VEXLearn material licensed by Eric Lee under CC BY 4.0, excluding third-party marks and depicted interfaces. TSMC's annual report remains download-only because TSMC's terms do not grant republication permission. Evaluation content is excluded from npm and MCPB package allowlists.

Package inspection excludes evaluation PDFs, tests, release archives, and development-only tooling.

## Extraction source research

The native table work reviewed how jztan/pdf-mcp combines ruled and text-aligned tables and scopes reassignment to header geometry. PyMuPDF checks candidate headers against a stable body. Decompiler independently uses repeated numeric right edges to find the body and assign the header. [jztan/pdf-mcp 3.8.0 table source](https://github.com/jztan/pdf-mcp/blob/9f49d972165357cce072ac984b8ce52c72a2f72e/src/pdf_mcp/backend/tables.py), [PyMuPDF 2.2 header source](https://github.com/pymupdf/PyMuPDF/blob/ac3ad01a923b647d7f963d288126259ca8a8fdbc/src/_table_headers.py)

Marker retries detected tables at higher resolution. MinerU Basic crops and orients table regions before recognizing and assigning their words. LiteParse passes physical DPI into Tesseract. Decompiler uses those techniques to guide its own bounded raster retries and validation of recognized table geometry. The changes use existing dependencies and include no upstream source or model weights. [Marker 2.2.1 table processor](https://github.com/datalab-to/marker/blob/32c374bfa01fb74e7ded42fa09f80f1a3e7f8a29/marker/processors/table.py), [MinerU 4.2.3 wheel, `backend/analysis/pdf/tables.py`](https://pypi.org/project/mineru/4.2.3/#files), [LiteParse 2.21.3 Tesseract backend](https://github.com/run-llama/liteparse/blob/95f4633a7e0693b3f4859db16ed4110ed8eb4310/crates/liteparse/src/ocr/tesseract.rs)

## v3.1 ownership and source distribution

On 2026-11-28, the repository owner confirmed ownership or relicensing authority for all pre-3.0 project source. The competitor evaluation used observed behavior and benchmarks, with project changes implemented independently.

The [v3.1.0 release](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/tag/v3.1.0) and [v3.1.1 release](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/tag/v3.1.1) distribute the same MuPDF Corresponding Source alongside the binaries. The archive starts from [Artifex's 1.27.0 source release](https://github.com/ArtifexSoftware/mupdf-downloads/releases/tag/1.27.0) and replaces `include/mupdf/fitz/version.h` with the version from [the npm package's exact source commit](https://github.com/ArtifexSoftware/mupdf/commit/7956afdc373785865f651fcb76f3112ab1208ba0). That header is the sole source change between the upstream tag and the npm commit. The archive contains the WASM build scripts and upstream third-party sources. The release checksums cover the archive, and both packages include the download link in their third-party notices.

Each later distribution that bundles MuPDF must keep the corresponding source accessible. Review native canvas notices on each target platform, PDF.js and Tesseract notices, model and tokenizer licensing at the pinned revision, and the npm and MCPB contents against the SBOM.
