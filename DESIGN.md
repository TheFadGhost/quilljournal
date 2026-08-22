# Quilljournal Design

## Point of view

Quilljournal is a quiet, warm, paper-like writing environment. It is not an app with a
text box in it; the text box is the app, and everything else is furniture arranged
around it. The canvas reads like uncoated paper — warm off-whites by day, deep warm
charcoal at night — with a serif composition face that asks for long-form thought.
Colour is spent almost nowhere except meaning: one ink accent for interactive things,
one danger colour for recording and destructive actions. There are no gradients, no
glass, no shadows except one elevation for genuinely floating layers (menus, modals).
Chrome is designed to disappear: it thins on focus mode to nothing but the text.

The register chosen: **quiet, warm, paper-like**. Not "restrained modern editor".

## Typography

### Composition surface (the writing area)

| Property | Value |
| --- | --- |
| Face | `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif` (system stack — no remote fonts, ever) |
| Size | 19px default; user-adjustable via `--font-size` scale steps 16–24px |
| Line height | 1.65 (`--leading-composition`) |
| Measure | **66 characters**, held constant regardless of window width via `max-width: calc(var(--measure) * 1ch)` on the composition column; user-adjustable 48–80ch. The measure is stated here as a requirement: composition stays between **60 and 70 characters** unless the user explicitly overrides it. |
| Paragraph spacing | One blank line between paragraphs: `margin-block: 0 0.9em`; no first-line indent |
| Caret | `caret-color: var(--caret)` — the theme's high-contrast ink accent, verified ≥ 3:1 against canvas in every theme (see token table) |
| Selection | `::selection { background: var(--selection-bg); color: var(--selection-ink) }` — tinted wash with ≥ 4.5:1 text contrast, verified per theme |
| Markdown | Typed as raw markdown in the composition surface (no live re-flow while writing). Preview toggles a rendered view using the same face/measure; `marked` + DOMPurify render headings, lists, emphasis, code, links (links open only after explicit confirmation — never silently). |

### UI type

| Role | Face | Sizes |
| --- | --- | --- |
| UI labels, list rows, buttons | `system-ui` stack | 13px base (`--text-ui`), 12px muted metadata (`--text-ui-small`) |
| Entry titles (list + editor header) | Composition serif | 15px list / 22px editor |
| Timers, word counts, shortcuts | `ui-monospace` stack | 12px |

### Scales

- Type scale: 12 · 13 · 15 · 19 · 22 · 28px (1.22 ratio above the 19px base).
- Space scale: 4 · 8 · 12 · 16 · 24 · 32 · 48px (`--space-1…7`). Layout rhythm uses multiples of 8.
- Radius: 4px controls, 8px surfaces. Border width: 1px.

## Colour tokens (roles, not hexes)

All colours exist as CSS custom properties under `:root[data-theme=…]`. No component
may hardcode a colour. Themes: `light`, `dark`, `night`, `high-contrast`.

| Token role | Purpose |
| --- | --- |
| `--bg-canvas` | App background (paper) |
| `--bg-surface` | Cards, list, panels |
| `--bg-inset` | Wells: transcript pane, code blocks |
| `--ink-high` | Primary text |
| `--ink-mid` | Secondary text |
| `--ink-muted` | Metadata (dates, tags, counts) — still ≥ 4.5:1 on its background |
| `--accent` | Interactive elements, links, focus ring fill |
| `--on-accent` | Text/icon on accent |
| `--caret` | Caret color (≥ 3:1 vs canvas) |
| `--selection-bg` / `--selection-ink` | Selection pair (≥ 4.5:1 together) |
| `--focus-ring` | Visible keyboard focus outline (2px, offset 2px) |
| `--danger` | Recording state, destructive actions |
| `--warn` | Paused-recording state |
| `--waveform-live` / `--waveform-idle` | Waveform bars (both ≥ 3:1 against every theme's recording surface) |

Theme character:

- **light**: warm paper `#faf7f2`, ink `#26221c`.
- **dark**: deep warm charcoal `#1d1a17` canvas, warm-white ink; accents desaturated amber.
- **night**: lowest blue content of any theme — near-black warm brown canvas `#171310`,
  candle-warm ink, all accent hues shifted amber/red, zero pure white.
- **high-contrast**: pure black/white, borders on every surface, AAA text targets.

Caret and selection contrast is verified per theme during the design audit; this is the
known failure point of themed editors and is treated as a release blocker here.

## Entry list

Rows are full-width surfaces separated by hairline rules, not cards. Anatomy,
top-to-bottom: **date line** (muted, small caps, e.g. "14 March 2026 · 09:12") →
**title** (serif, 15px) → **excerpt** (single source of truth for excerpting below) →
**meta line** (muted): tag chips (square-cornered, outlined, never coloured mood
markers), marker chips, word count, audio indicator glyph if retained audio exists.
A long entry is excerpted to the first 160 characters of plain-text body, cut at a word
boundary, ending in an ellipsis — never mid-word, never fading out via gradient mask
(gradient-fade excerpts hide whether there is more text).

## Marker system (user-defined states)

Markers are user-defined single words or short phrases ("tired", "good day", "grief"),
rendered as outlined square chips with a leading tick mark — deliberately unlike emoji
and unlike coloured-dot mood systems. Markers carry no colour coding chosen by the app;
colour would imply the app interprets them, which it must not. They are filterable and
searchable exactly like tags.

## Recording UI

One persistent strip, the **recording bar**, docked to the bottom of the window
whenever a session exists. States must be unmistakable without reading a single label:

| State | Visual | Motion |
| --- | --- | --- |
| Idle (armed, not started) | Hollow circle, waveform bars at zero, timer `00:00` dimmed | none |
| Recording | Filled red circle + timer counting + live waveform bars | Bars animate from mic amplitude; `prefers-reduced-motion`: filled dot is static, bars replaced by a static "REC" badge — motion is never load-bearing |
| Paused | Amber hollow circle, timer frozen, waveform bars frozen and dimmed | none |
| Processing | Red circle replaced by progress bar toward provider progress (indeterminate bar when provider reports none) | Bar animates; reduced-motion: static bar + text percentage |

While recording and the window loses focus, the main window shows a 2px `--danger`
border, **and** a separate always-on-top mini-window appears ("Recording — Quilljournal",
filled red dot, elapsed time). A recording with no visible indicator is a serious defect;
this is the mitigation, and it is tested.

Waveform treatment: 3px-wide rounded vertical bars, 2px gaps, mirrored around centre,
`--waveform-live` colour on `--bg-surface`. Peak-hold decays slowly. The canvas has a
hairline border so it remains legible on every background.

Pause/resume, stop/finalize, cancel are all buttons in the bar; every control has a
tooltip *and* is reachable by keyboard, and state changes are announced through an
`aria-live="polite"` region ("Recording paused", "Transcription complete").

## Transcript review

Split layout: left = audio player (play/pause, scrubber with recorded-range overview,
speed control), right = editable textarea pre-filled with the raw transcript, same
composition typography at 17px. When the provider supplies word timings, the played word
is underlined with `--accent` and clicking a word seeks playback there; alignment is
displayed as an aid, never auto-applied formatting. Below the text: "Commit to entry"
(primary), "Discard audio after commit" checkbox (unchecked by default — audio is never
silently destroyed), "Discard transcript". If the transcript is empty because the
provider failed, the review screen says so plainly and offers retry/cancel; fabricated
text is never substituted.

## States (every surface defines these)

| State | Treatment |
| --- | --- |
| First run | Onboarding page: what stays local, exact storage path, provider explanation, prompt opt-in. Dismissed once, remembered. |
| Empty (no entries) | Canvas-centred: date, one bundled prompt (if enabled), "Write today's entry". No cheerfulness, no streak language. |
| Loading | Skeleton hairlines in lists; never spinners over text areas. |
| Saving | Footer-right indicator cycles `Saving…` → `Saved 14:32`; honest (reflects real flush), non-animated, announced politely to screen readers once per transition. |
| Error | Inline, adjacent to the thing that failed, with a concrete next action ("No microphone found — check it's connected"). Errors never use cheerful language. |
| No results (search) | "No entries match." + active filter summary + clear-filters action. |
| No microphone / permission denied | Recording bar shows the specific cause and OS-settings hint where applicable; never a generic failure. |

## Interaction rules

- Every action operable by keyboard; visible `--focus-ring` on all interactive
  elements; `?` opens the shortcut sheet (modal, listed in it too).
- `prefers-reduced-motion` collapses all animation to instant or static states.
- RTL and unicode: logical CSS properties everywhere (`margin-inline-start`, not
  `margin-left`); the composition surface sets `dir="auto"` so mixed-direction text
  renders correctly.
- Idle lock (optional setting): after N idle minutes the content blurs and unlock
  requires click/passphrase (passphrase check only when encryption is on).

## Print/export form

Print stylesheet: hides all chrome, prints entries as dated headed documents with the
composition face, markers/tags/metadata as a footer line per entry. The exported HTML
print file uses identical styles inline so the printed form matches outside the app.
