# Release Procedure

Publication, remote pushes, releases, and tags require separate authorization. Verification scripts never publish.

1. Confirm the release commit contains only intended changes and prior release tags or the archival branch remain available.
2. Run `npm ci`, fixture verification, schema generation, `npm audit`, `npm test`, Windows OCR when Tesseract is installed, repository and documentation checks, license review, benchmark, SBOM, package inspection, and release verification on Windows Node 22 and 24. This is the blocking platform gate.
3. Run the configured macOS and Linux jobs when those environments are available. Record them as passed, failed, partial, or unverified. Unavailable best-effort jobs do not block this corrective effort and do not support a compatibility claim.
4. Complete the ownership and Corresponding Source decisions in [`PROVENANCE.md`](PROVENANCE.md).
5. Record the Claude Desktop and Codex checks with versions, dates, and limitations. Only claim desktop compatibility for a client that passed the manual checks. Mark an MCPB bundle as a preview if desktop installation remains unverified.
6. Before publishing to the npm registry, run `npm run release:verify -- --release-time`. Report any name conflict and keep the package name. The GitHub release can distribute the inspected tarball with the npm private guard enabled.
7. Run `npm run package:verify -- <clean-output-directory>`. Inspect npm and MCPB file lists, SPDX SBOM, checksums, native binaries, and licenses.
8. Test each platform-specific MCPB on a clean machine before claiming that package supports the platform. Attach the MuPDF source archive alongside the binary artifacts and include its SHA-256 checksum.
9. Confirm README commands and package hashes match the tested commit.
10. Obtain authorization to publish, push, or tag. Changing the `private` guard is only needed for a separately authorized npm registry publication.

Never rewrite Git history, delete legacy tags, force-push, or silently change the package name.
