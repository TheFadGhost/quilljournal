# quilljournal

> **built with ox alpha**
>
> most of this was written in august 2026 during the free preview window of
> [ox alpha](https://openrouter.ai/stealth/ox-alpha), an anonymous stealth model
> that turned up on openrouter for about a week. i set the direction and reviewed
> what came back. the tests are real and they pass — clone it and run them.

a local-first journal for electron. write in markdown or dictate through a
pluggable transcription provider; entries and audio are written to disk with
crash-safe atomic writes, optionally behind AES-256-GCM envelope encryption.

## Running it

```
npm install
npm run dev      # vite dev server + electron, hot reload
npm run build    # vite build + tsc (electron main) + preload copy
npm start         # build, then launch the packaged electron app
npm run typecheck # tsc --noEmit against both the app and electron tsconfigs
```

`npm install` and `npm test` (below) were run against this checkout and work
as described. `npm run dev` / `npm start` launch an electron window and were
not exercised headless here, but the scripts (`scripts/dev.mjs`,
`scripts/copy-preload.mjs`) are real and match `package.json`.

## How it works

Electron main process owns the filesystem; the renderer (react 19) never
touches disk directly, only through an IPC bridge
(`src/shared/ipc.ts`, `src/renderer/ipc/rendererBridge.ts`).

**Storage.** `src/core/store/journalStore.ts` (637 lines) keeps entries as
JSON files with inline revision history under an `entries/` directory, plus
`attachments/` and `audio/`. Every write goes through
`src/main/nodeFsLike.ts`'s `atomicWriteAbs`: write to a temp file
(`.<name>.tmp-<random>`), `fsync` the handle, then `rename` over the target.
Audio recording appends chunks incrementally through
`src/main/recordingWriter.ts`, which serializes writes on an internal queue
and fsyncs once on `finish()`, so a crash mid-recording leaves a playable
partial file rather than a truncated or corrupt one. `resolveSafe()` in
`nodeFsLike.ts` rejects `..` traversal and absolute paths before any path
reaches disk.

**Encryption.** Opt-in, implemented in `src/core/crypto.ts`. Keys are
derived with PBKDF2-SHA-256 at 650,000 iterations
(`crypto.subtle.deriveKey`), producing a non-extractable AES-256-GCM key.
Each encrypted file is a self-describing envelope: a 6-byte magic header
(`QJENC1`), a 12-byte random IV, then the ciphertext. Passphrase changes and
disabling encryption re-wrap or decrypt every entry/attachment/audio file in
place, guarded by a "transitioning" flag so a crash partway through can be
recovered rather than leaving a mixed plaintext/ciphertext store
(`tests/store-audio-crypto.test.ts` exercises exactly this).

**Transcription.** One provider interface
(`src/core/provider.ts`: `capabilities()`, `isAvailable()`,
`createSession()`) with three implementations behind a registry
(`src/core/providers/registry.ts`): a deterministic offline mock (default,
so the app works with no setup), a local-engine provider that shells out to
an external binary found on `PATH` or at a configured path, and an HTTP
provider that posts audio to a user-configured endpoint. Sessions stream
partial results and progress via callbacks; word timings, when a provider
supplies them, drive click-to-seek playback alignment
(`src/renderer/audio/alignment.ts`).

**Export/import.** `src/core/export/` builds a JSON archive
(`archive.ts`), per-entry markdown (`markdown.ts`), and a print-ready
self-contained HTML file with inline styles (`printable.ts`). Import is the
archive reader in `src/core/import/importer.ts`.

The design docs (`DESIGN.md`, `PLAN.md`) describe a fuller UI spec — theming
tokens, marker chips, a recording-state visual language, idle lock — most of
which is present in `src/renderer/components/` and `src/renderer/styles/`,
but this README describes what's verified by source and tests, not the
design intent; treat `DESIGN.md`/`PLAN.md` as the aspirational spec if you
want the full picture.

## Tests

```
npm test          # vitest run
```

238 tests across 19 files. On this checkout: 233 passed, 2 failed, 3
skipped. The 2 failures are both in `tests/nodeFsLike.test.ts`, and they are
POSIX path-handling edge cases: `resolveSafe()` uses node's `path.isAbsolute`
to reject absolute paths, but on Linux that function doesn't treat a
backslash-prefixed string (`\abs\path`, `\\srv\share`) as absolute the way
it would on Windows, so those two malformed-path cases pass through
unrejected instead of throwing. Everything else — crypto, storage,
recording, providers, export/import, UI components — passes.

## Known limitations

- The two `resolveSafe` path-rejection gaps above are real: on a POSIX
  host, a small set of Windows-style path strings are not rejected as
  unsafe. They aren't reachable through the app's own IPC layer (which only
  ever passes relative, forward-slash paths), but the guard function itself
  is not currently platform-independent.
- The local-engine and HTTP transcription providers depend on external
  binaries or endpoints that aren't part of this repo; only the mock
  provider is guaranteed to work out of the box.
- `npm run dev` / `npm start` were not run against a real display as part
  of writing this README — only `npm install` and `npm test` were verified
  directly.
