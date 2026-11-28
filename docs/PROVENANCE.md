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

## v3.1 ownership and source distribution

On 2026-11-28, the repository owner confirmed ownership or relicensing authority for all pre-3.0 project source. The competitor evaluation used observed behavior and benchmarks, with project changes implemented independently.

The [v3.1.0 release](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/tag/v3.1.0) and [v3.1.1 release](https://github.com/noobieisgod/pdf-decompiler-mcp/releases/tag/v3.1.1) distribute the same MuPDF Corresponding Source alongside the binaries. The archive starts from [Artifex's 1.27.0 source release](https://github.com/ArtifexSoftware/mupdf-downloads/releases/tag/1.27.0) and replaces `include/mupdf/fitz/version.h` with the version from [the npm package's exact source commit](https://github.com/ArtifexSoftware/mupdf/commit/7956afdc373785865f651fcb76f3112ab1208ba0). That header is the sole source change between the upstream tag and the npm commit. The archive contains the WASM build scripts and upstream third-party sources. The release checksums cover the archive, and both packages include the download link in their third-party notices.

Each later distribution that bundles MuPDF must keep the corresponding source accessible. Review native canvas notices on each target platform, PDF.js and Tesseract notices, model and tokenizer licensing at the pinned revision, and the npm and MCPB contents against the SBOM.
