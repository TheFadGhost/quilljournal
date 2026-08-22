# Quilljournal Plan

A private, local-first journal you can type or speak into. Everything stays on disk;
the mock transcription provider makes every feature work offline out of the box.

## Feature ideation — judged

Each candidate was tested against: (1) does it serve capturing and revisiting personal
writing, (2) can it be finished to the same quality bar, (3) does it avoid becoming a
second product.

### Accepted (first-class features under the same loop and audit)

| Idea | Reason |
| --- | --- |
| First-run onboarding explaining privacy and storage location | The promise of the product *is* privacy; showing where data lives earns it in 30 seconds. |
| Sensible defaults (autosave on, mock provider active, prompts off) | A journal must be usable within a minute of first launch, zero configuration. |
| Specific microphone errors (no device vs permission denied vs device vanished mid-recording) | Recording failures are the scariest failure mode for someone's spoken thoughts; vague errors are unacceptable. |
| Global "new entry" keyboard shortcut | Capturing a thought must beat the friction of switching windows and clicking. |
| Autosave with an honest saved indicator | Silent loss of writing is the one unforgivable defect of a journal. |
| Word count and writing time | Quiet, factual feedback that helps people write without gamifying it. |
| Distraction-free mode | The writing surface is the entire product; chrome should be dismissible entirely. |
| Lock/blur-on-idle option | Journals are read over shoulders; a cheap, opt-in guard respects that. |
| Accessible recording flow (screen reader announcements, full keyboard operation) | Dictation is an accessibility feature itself; shipping it inaccessible would be self-defeating. |
| Periodic backup reminder (points at Export) | Durability beyond the app's own crash-safety is a real user need and Export already exists to serve it. |

### Rejected

| Idea | Reason |
| --- | --- |
| Mood analytics / emotional scoring / clinical framing | Rejected on principle, not scope: the app must never analyse or score emotional state or pose as a mental-health tool. |
| Therapy-adjacent insight engine | Second product; also implies the app may generate advice about what the user wrote. |
| Social sharing | Second product; directly hostile to the private-by-default premise. |
| Cloud sync with accounts | Second product; an account model contradicts "no account, everything local". |
| Gamified streaks / badges / "you've journalled N days!" cheerfulness | Coercive engagement mechanics shame exactly the users a journal should never shame. |

## Architecture in one paragraph

Electron app. The renderer is React; the main process owns the filesystem so every
write goes through one atomic-write path (temp file, fsync, rename). Entries are JSON
files with full inline revision history; audio is appended chunk-by-chunk to a file as
it records, so a crash mid-recording leaves a playable file. Transcription sits behind
one provider contract with three implementations: an offline deterministic mock
(default), an optional local-engine file transcriber, and an optional user-configured
HTTP endpoint. Encryption is opt-in envelope encryption (AES-256-GCM via WebCrypto,
PBKDF2-SHA-256 key derivation) applied per file before any byte touches disk.

## Build order

1. Contracts I own before anything else: entry schema, provider interface, error kinds, date keys.
2. Storage engine + atomic writes + revision history (+crash simulations).
3. Provider contract conformance suite + mock provider.
4. Audio capture (incremental write) + playback.
5. Editor/writing surface, transcript review, search/navigation.
6. Encryption module, export/import, prompts, themes.
7. Regression gate re-runs after every storage/editor change (crash-during-write,
   crash-during-recording scenarios re-verified).
8. Audits by agents that did not write what they review; fix loop; v1.0.0 only at zero findings.
