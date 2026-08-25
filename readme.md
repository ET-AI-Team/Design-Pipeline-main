# Automated Creative Production Pipeline

**This document describes what the code actually does today.** It is regenerated
from a full line-by-line read of the real source under `apps/api`, `apps/dashboard`,
and `packages/shared-types` — not from the original design docs (those, along with
their planning PDFs, have been removed; the code is now the only source of truth).
Last verified against source: **2026-08-25**. This pipeline changes fast — if you're
reading this much later, re-check the files named in each section before trusting a
specific number or model name.

---

## 1. What this is

An internal tool that turns **4 inputs** into a finished ad creative, mostly
automatically:

1. **Reference 1** — subject/scenario direction ("what kind of photo is this").
2. **Reference 2** — the layout reference ("what the finished ad's design looks
   like": headline, CTA, trust badges, etc).
3. **Logo** — brand logo, PNG or SVG.
4. **Prompt** — a text brief: campaign theme, tone, what the copy should say.

Output: one finished **1:1 poster**, reviewed by a human once, then automatically
expanded into **3 more aspect ratios** (9:16, 4:5, 1.91:1) in parallel. Every AI
generation/edit step is graded by a *different* model than the one that produced it,
never the same model grading its own work. A failing score retries with the judge's
own feedback folded into the next attempt, up to a small cap; still-failing work is
parked in a **Needs Attention** queue for a human, never silently shipped bad.

No auth, no multi-tenancy — internal-only, trusted network, single instance.

---

## 2. The pipeline, visually

```
 INPUT: reference1 + reference2 + logo + text brief
   │
   ▼
 ┌────────────────────────────┐
 │ base_layer_classification  │  GPT-4.1 (vision) — reads reference2 like a
 │ "how is this reference     │  designer would: composition, background
 │  actually built?"          │  treatment, photo style. No fixed categories.
 └──────────────┬─────────────┘
                │ PASS → cached once on Job.baseLayerSpecJson
                ▼
 ┌────────────────────────────┐
 │ base_asset                 │  Gemini Pro (full generation) — a brand-new,
 │ generate the clean photo   │  text-free, logo-free photo matching the
 └──────────────┬─────────────┘  brief + the classified style.
                │ PASS → Job.baseAssetUrl
                ▼
 ┌────────────────────────────┐
 │ logo_composite             │  GPT-4.1 (1 coordinate) decides WHERE,
 │ decide + place the logo    │  sharp places the REAL logo pixels, then a
 └──────────────┬─────────────┘  real vision QA checks the placement.
                │ PASS → Job.baseAssetUrl (overwritten with logo baked in)
                ▼
 ┌────────────────────────────┐
 │ poster                     │  GPT-4.1 reads the design + writes the copy,
 │ style + copy + full-       │  gpt-image-2 does ONE full-image edit (no
 │ context edit + verify      │  mask) adding all text/CTA/trust-list, then
 └──────────────┬─────────────┘  GPT-4.1 verifies word-for-word + untouched photo.
                │ PASS → Job.posterUrl, status = AWAITING_APPROVAL
                ▼
 ┌────────────────────────────┐
 │        HUMAN APPROVAL       │  no timeout — the only required human step
 └───────┬──────────────┬─────┘
     reject│              │approve
           ▼              ▼
     ┌───────────┐  ┌─────────────────────────────────────────────┐
     │ REJECTED   │  │ dimension_9x16 ┐                             │
     │ (terminal) │  │ dimension_4x5  ├─ all 3, genuinely parallel   │  Gemini Pro,
     │            │  │ dimension_1.91x1┘  (Promise.all)              │  full regen
     └───────────┘  └───────────────────┬───────────────────────────┘
                                         │ once ALL 3 reach a terminal state
                                         ▼
                                   ┌───────────┐
                                   │ COMPLETE   │  (one failed dimension never
                                   └───────────┘   blocks the other two)
```

Registered stage names, in dispatch order (`apps/api/src/stages/index.ts`):
`base_layer_classification → base_asset → logo_composite → poster →
dimension_9x16 / dimension_4x5 / dimension_1.91x1`.

**There is no separate "logo detection" stage.** An earlier version had the AI pick
a box in one stage and a second stage place it; that was folded into one
(`logo_composite`) specifically so a failed post-placement QA can ask for a genuinely
*new* AI-chosen coordinate on retry — two separately-tracked stages couldn't retry
together cleanly against this repo's idempotent-dispatch rule (see §7).

---

## 3. The pass / retry / escalate loop (every AI-judged step, same rule)

One rule, defined once (`orchestrator/handle-stage-result.ts`), applied to every
content-quality decision in the system:

| Condition | Result |
|---|---|
| `qaScore >= QA_PASS_THRESHOLD` (**7**) | **PASS** → advance to the next stage |
| `qaScore < 7` and `attemptNumber < MAX_CONTENT_RETRIES` (**2**) | **RETRY** → re-run with the judge's own reasoning appended to the prompt |
| `qaScore < 7` and `attemptNumber == 2` | **ESCALATED** → job (or just that one dimension) moves to `NEEDS_ATTENTION`, a human can hit Retry |

This is deliberately separate from **technical** failures (bad API key, network
error, 429/5xx). Those are retried by BullMQ itself (`attempts: 3`, exponential
backoff) and never eat into the content-quality budget above — a network blip on
attempt 1 doesn't cost you one of your 2 real tries.

Every attempt — pass, retry, or escalated — is written as its own `StageAttempt` row
with its own uploaded asset, cost, latency, and QA reasoning. Nothing is thrown away;
a job's full history is always inspectable.

---

## 4. The pipeline, stage by stage, in depth

### 4.0 — `base_layer_classification`
**File:** `stages/base-layer-classification.stage.ts` · **Queue:** `vision-scoring` ·
**Model:** GPT-4.1 vision (`openai.client.ts`'s `classifyBaseLayer`)

Sends Reference 2 (the layout reference, labeled as the thing to actually classify)
and Reference 1 (labeled as subject-direction context only) to GPT-4.1, and asks it
to describe, in its own words:

- **`compositionGuide`** — where the subject sits, where the eye finds clean space,
  how the two relate — specific enough that a brand-new photo of a *different*
  subject could be generated to compose the same way. Not a category label.
- **`backgroundTreatment`** — any non-photographic design element (a color block, a
  gradient, a textured surface) that isn't part of the photo's own natural content
  and needs to be baked into the new photo generation to match. Empty string if
  there isn't one. Anything that spells out letters/words/numbers — however faded or
  decorative — is explicitly treated as *text*, never described here.
- **`photoStyle`** — `colorGrading`, `lighting`, `setting`, `framing`, each its own
  freeform sentence.

Validation is deterministic and narrow (`isValidBaseLayerSpec`): are the guide/style
fields non-empty strings? There's no fixed enum or numeric range to check anymore —
an earlier version forced this into 5 fixed composition archetypes plus a clamped
`exclusionZone` box; that was removed because real geometry (where the logo goes,
where text goes) is now decided *later*, by looking at the real generated photo, not
guessed from a classification of the reference. Result on PASS is cached once on
`Job.baseLayerSpecJson` and reused by every later `base_asset` retry.

### 4.1 — `base_asset`
**File:** `stages/base-asset.stage.ts` · **Queue:** `image-generation` ·
**Model:** `GEMINI_PRO_MODEL` (`gemini-3-pro-image`) via `generateAndScore()`

Builds a structured prompt (`BaseAssetPrompt`) from the cached classification +
the raw brief, and asks Gemini for a brand-new, photorealistic photo that:
- Matches the brief's actual subject/scene (Indian setting/subject by default unless
  the brief says otherwise).
- Matches the classified photographic style (color grading, lighting, setting,
  framing) and any classified background treatment.
- Has **zero text, logo, or watermark anywhere** — composited later, deterministically.
- Requests real, unretouched-looking realism (visible skin texture, natural
  asymmetry) — explicitly rejects the "smooth AI-render" look.

Both reference images are attached as labeled image parts (a bare, unlabeled image
was confirmed live to get silently ignored by the model — every multi-image call in
this codebase labels every image for that reason). The negative-text instruction and
the realism block are stated at both the top and the bottom of the prompt
("bookended") — a single trailing mention was confirmed live to lose against a
detailed brief that had its own copy embedded in it.

**`enforceSquare: true`** is passed to `generateAndScore()` — Gemini has been
observed ignoring the "1:1 square" instruction outright (returned 1408×768 on a real
run); the result is center-cropped to square in code (`enforceSquareCanvas` in
`stages/generate-and-score.ts`) since every later box-geometry calculation assumes a
genuinely square canvas.

QA rubric (`buildBaseAssetRubric`): scored by GPT-4.1 against the *actual* reference
images and the classified style (not a generic fixed bar), with a hard automatic-fail
for any rendered ad-copy-style text — but explicit carve-outs for authentic
incidental environmental text (real signage, carved inscriptions) that's a natural
part of an honest scene.

### 4.2 — `logo_composite`
**Files:** `stages/logo-composite.stage.ts` (near-empty registration) +
`orchestrator/run-deterministic-stage.ts`'s `runLogoCompositeStage` (the real work) +
`orchestrator/logo-placement.ts` (pure geometry helpers)

`isDeterministic: true` — **never touches a BullMQ queue.** The Orchestrator runs it
inline, synchronously, right after the transaction that advanced to this stage
commits. But it is *not* an unconditional pass — it has a real AI decision and a real
QA gate baked in, so it can genuinely RETRY or ESCALATE like any queued stage.

What actually happens, in order:
1. **Size the logo, deterministically.** `computeLogoDimensions()` sizes the logo as
   a fraction of canvas width (22%), aspect-ratio preserved, capped at 11% of canvas
   height so a near-square logo can't balloon. The model is never asked to size it.
2. **Ask the model for exactly one thing: where.** `detectLogoPosition()` (GPT-4.1)
   is shown the real generated photo, the logo's already-decided size, a margin hint,
   and a hard constraint that the logo's top edge must stay in the top ~15% of the
   frame — then asked for one `{x, y}` pixel coordinate. On a retry, the previous
   attempt's own QA feedback is folded into the ask.
3. **Clamp, never trust blind.** `clampLogoPosition()` forces the returned coordinate
   into the real valid range for this canvas/logo size (a non-finite value falls back
   to `(0,0)` and scores an automatic 3, no retry wasted debating a malformed answer).
4. **Composite with real image-quality care.** `sharp`, `fit: 'contain'` (never the
   default `'cover'`, which was confirmed live to crop a wide/short logo into an
   illegible blown-up fragment), `kernel: 'lanczos3'` + a light `.sharpen()` pass
   since most uploaded logos (e.g. 183×42) are being *upscaled* into their detected
   box, which visibly softens them without this.
5. **Real QA on the whole composited image.** Not the old unconditional pass this
   stage used to give itself — `scoreImage()` checks the placement for anything that
   looks awkward, cramped, or covering something important, with the campaign's real
   reference image attached as a visual anchor.

Same PASS/RETRY/ESCALATE rule as everywhere else. On PASS, `Job.baseAssetUrl` is
**overwritten** with the logo-composited image — `base_asset` and `logo_composite`
both write to the same field on purpose, since it's the one "current best base image"
every downstream stage reads from.

### 4.3 — `poster`
**Files:** `stages/poster.stage.ts` (registration only) +
`run-deterministic-stage.ts`'s `runPosterStage` + `orchestrator/poster-text-edit.ts`
(the real machinery) + `orchestrator/render-poster.ts` (style extraction + clamping)

Also `isDeterministic: true` (inline, no queue) with a real, retryable QA gate — same
shape as `logo_composite`. This stage has been rebuilt multiple times over the
project's life; what's described here is the **current** design.

**Step A — read the reference's actual design.** `getOrExtractStyle()` calls
`analyzeReferenceStyle()` (GPT-4.1 vision, low temperature for run-to-run
consistency), looking at *two* images together: Reference 2 (for content/hierarchy —
which elements even exist) and the real current photo+logo composite (for size
ratios, since the two canvases can differ). It returns a rich `PosterStyleSpec`:
margins, per-line headline typography (font size/weight/color/gradient/freeform style
description, judged independently per line — a reference can genuinely use two
different fonts across two headline lines), whether a standalone CTA button exists at
all, the bottom info block's *real* structure (a plain bulleted list, a full-width
bar, a boxed card with a price row — never forced into one fixed "trust list"
template), a catch-all `otherElements` array for anything else (a co-branding badge, a
date/location chip), and the reference's actual top-to-bottom `elementOrder`. Every
numeric field is defensively clamped to a sane range in `clampStyle()`
(`render-poster.ts`) — an estimate is clamped, never discarded or replaced with a
generic default. **This extraction is deliberately not cached** — every attempt
re-extracts fresh while this design is still being iterated on (despite
`Job.styleSpecJson` still existing in the schema from an earlier cached version).

**Step B — write the copy.** `generateAdCopy()` (GPT-4.1, text-only, cheap) writes
headline/subtext/CTA/price/trust-item/badge text matched exactly to the structure
Step A found (a 2-line reference gets exactly 2 headline lines; no CTA in the
reference means no CTA text is written). Critical rule: if the brief doesn't give it
something specific (a real date, price, location), it returns `null` rather than
inventing a plausible-sounding fake value or a placeholder-sounding label — both were
real, live-found defects. Every hyphen/en-dash/em-dash in the output is stripped
deterministically afterward (`stripDashesFromLines`) regardless of whether the model
honored the "no dashes" instruction — it hasn't, reliably, in real runs.

**Step C — one full-context edit, no mask.** `runFullContextEdit()` builds one very
detailed prompt (`buildFullContextEditPrompt`) describing exactly what already exists
and must not change (the photo, its established style, the logo's exact pixel
position) and exactly what to add (the copy from Step B, laid out using Step A's
real ratios stated as both percentages *and* concrete pixel numbers). Real crops of
specific reference elements (headline font, CTA style, etc.) are attached alongside
the prose — confirmed live that a model copies a picture's structure far more
reliably than any amount of description. This is sent as one `/v1/images/edits` call
(`gpt-image-2`, `editPosterImage()`) against the whole photo+logo image with **no
mask** — an earlier "masked, layer-by-layer" design (separate AI edits for
headline+subtext / CTA / trust-list, each in its own protected region, with a
two-tier per-layer-then-holistic verification system) was built, tested, and then
replaced by this simpler single-call design; see §6 for why.

**Step D — verify.** One GPT-4.1 vision call (`buildVerificationRubric`) checks,
together: does every piece of text read back word-for-word correct (case/punctuation
differences explicitly do **not** count as failures), is the logo/photo genuinely
unaltered (the real pre-edit composite is attached as a "before" image specifically
so this check has something real to compare against), does nothing overlap or get
cut off, and — symmetrically — does anything appear that the style spec said
*shouldn't* exist (a hallucinated CTA button on a reference that has none, etc).

No deterministic fallback exists anymore on a final failed attempt — a stuck job
escalates to `NEEDS_ATTENTION` like everything else; a prior version silently fell
back to an old renderer on the 3rd failure, which was removed on purpose ("a visibly
stuck job is preferable to a silently-degraded one").

### 4.4 — Human approval
Not a registered stage — a state the Orchestrator reaches when a stage's
`nextStageOnPass` is the sentinel `'AWAITING_APPROVAL'` (only `poster` uses this).
`Job.posterUrl` is set and the poster is pushed live to the dashboard over the
socket. **No timeout, by design** — this is the one required human decision in the
whole pipeline.

- **Approve** → `Job.status = DIMENSION_EXPANDING`, all 3 dimension jobs dispatched.
- **Reject** (optional comment) → `Job.status = REJECTED`, terminal. Nothing further
  happens automatically; a person can start a fresh job reusing the same references
  with the note folded into a new prompt (the dashboard's "Regenerate with changes"
  does exactly this — see §10).

### 4.5 — `dimension_9x16` / `dimension_4x5` / `dimension_1.91x1`
**File:** `stages/dimension.stage.ts` · **Queue:** `image-generation` ·
**Model:** `GEMINI_PRO_MODEL`

Registered in a loop over `DIMENSION_NAMES` (from `shared-types`) — the one place the
"never copy-paste, extract a parameter" rule is most visible in this codebase. Each
dimension takes the **already-approved, fully-flattened** `posterUrl` (text and logo
already baked in) and asks Gemini to recompose it into the new aspect ratio in one
shot: extend the background naturally, never stretch the subject, read as one
continuous photograph with no visible seam.

This is deliberately the **one stage that still works the old, riskier way** — a
full AI regeneration of an already-finished image, rather than extending the clean
base photo and re-running the deterministic logo+text steps on the new canvas (which
would *guarantee* the words can never accidentally change between sizes). That
rework has been discussed but not built.

Each of the 3 is its own `DimensionJob` row, dispatched **genuinely in parallel**
(`Promise.all` in `dimension-orchestrator.ts`'s `onApproved`), and goes through the
exact same pass/retry/escalate machinery as every other stage, just scoped to a
`DimensionJob` instead of the parent `Job`. `checkForCompletion()` moves the parent
to `COMPLETE` only once **all 3** have reached a terminal state (`DELIVERED` or
`NEEDS_ATTENTION`) — one dimension failing never blocks the other two, and a failed
one can be retried alone without touching the poster or its siblings.

---

## 5. Model usage, at a glance

| Call | Model (env var) | Cost snapshot | Why this model |
|---|---|---|---|
| `base_layer_classification` | GPT-4.1 vision (`OPENAI_VISION_MODEL`) | ₹0.44/call | Reads the reference like a designer, no image generation needed |
| `base_asset` generation | Gemini Pro (`GEMINI_PRO_MODEL`) | ₹11.7/call | Hardest instruction-following task in the pipeline; Flash was validated against a simpler fixed template and no longer fits |
| every `scoreImage` QA call | GPT-4.1 vision | ₹0.44/call | Deliberately a *different* model than whatever generated the thing being judged — never self-graded |
| `logo_composite`'s position call | GPT-4.1 vision | ₹0.44/call | One coordinate only; everything else (size, clamping) is pure code |
| `analyzeReferenceStyle` | GPT-4.1 vision | ₹0.44/call | Structure extraction, run per attempt (uncached) |
| `generateAdCopy` | GPT-4.1, text-only | ₹0.15/call | No image tokens needed — meaningfully cheaper |
| poster's full-context edit | `gpt-image-2` (`OPENAI_IMAGE_EDIT_MODEL`) | ₹14.5/call | Real `/v1/images/edits` multipart call, "high" quality tier |
| `dimension_*` ×3 | Gemini Pro | ₹11.7/call each | `GEMINI_FLASH_MODEL` is configured but currently unused by any stage — switching is a one-line change, not yet validated as safe for this quality bar |

Every provider call throws loudly and immediately if its API key or model env var is
unset — no silent fallback to a hardcoded string.

---

## 6. Why it looks like this — the short version

Two earlier architecture generations existed for the `poster`/logo-text layer before
the current one:

1. **Full regeneration.** `poster` used to ask Gemini to redraw the *entire* image
   with text baked in by the generator, using the previous stage's output as a loose
   reference. Diffusion-style generation doesn't reproduce a reference pixel-for-
   pixel — it reinterprets it (texture drift, lighting shifts, general softness).
   Since `base_asset` is *itself* a full generation, this meant every poster was two
   independent generative hops removed from anything "real," each with its own
   drift, stacked on top of the other.
2. **Deterministic SVG rendering, then masked per-layer AI edits.** Moved off full
   regeneration entirely: first onto pure `sharp`/SVG-rendered text (fast, exact, but
   visually flat/generic), then onto a "Layered Text-Composition Architecture" —
   separate masked `gpt-image-2` edits per element (headline+subtext / CTA / trust
   list), each independently verified, then composited together with feathered
   blending. This fixed the generation-drift problem but introduced its own new
   class of bugs: seams between independently-generated pieces, occasional missing
   elements, and a real mechanical conflict with this repo's idempotent-dispatch
   design once a layer needed its own retry loop.
3. **Full-context single edit (current).** One `gpt-image-2` call, no mask, sees the
   whole photo+logo and is trusted with an extremely detailed prompt plus real
   reference-image crops for style fidelity, verified by one holistic pass instead of
   a two-tier per-layer system. The tradeoff is explicit: this gives up the *hard*
   guarantee a mask gave that the photo/logo can't be touched, in exchange for one
   simpler, more directly-controllable step — and leans on prompt specificity plus
   the verification gate to catch a violation instead of making one structurally
   impossible.

`logo_composite` went through the same "stop asking the model to draw pixels it
doesn't need to draw" arc earlier and independently — it's why logo placement is now
one coordinate decision + pure `sharp` math, not a generation.

---

## 7. The Orchestrator engine

**Every stage plugs into one interface** (`orchestrator/types.ts`'s
`StageDefinition`): a `name`, which `queue` it uses, `buildPrompt()`,
`getInputAssetUrl()`, `nextStageOnPass` (a stage name, the sentinel
`'AWAITING_APPROVAL'`, or `undefined` for a terminal stage), an optional
`isDeterministic` flag, and an optional `execute()` for queued stages. The engine
(`handle-stage-result.ts`) never contains a stage name as a string literal outside of
routing through this interface — adding a new stage means writing a config object,
not touching retry/transaction/idempotency logic.

**Transaction, then post-commit side effects — never mixed.** `handleStageResult()`'s
DB transaction only ever does DB writes (recording the `StageAttempt`, deciding
pass/retry/escalate, updating `Job`/`DimensionJob` status). Every side effect —
dispatching the next queue job, running a deterministic stage inline, emitting socket
events — is captured as a thunk and only executed *after* the transaction commits.
This exists because an earlier version ran `logo_composite`'s real work (network
fetches, `sharp` compositing, a Cloudinary upload) *inside* the transaction, which
routinely took 7–11+ seconds — past Postgres/Prisma's default interactive-transaction
timeout — and silently rolled back an otherwise-successful stage update.

**Idempotent dispatch** (`queues/dispatch.ts`): the `StageAttempt` row *is* the lock.
`dispatchStageJob()` first tries to `create` a placeholder row for
`(jobId, stage, attemptNumber)`; if that hits the unique constraint, this exact
attempt was already dispatched and the call is a silent no-op — never a duplicate
paid provider call. Only after the placeholder is safely written does it enqueue the
real BullMQ job.

**Retrying a stuck job** (`retry-stuck-job.ts`) resets the escalated stage's attempt
count back to 1 — but a naive re-dispatch at `attemptNumber: 1` would be a silent
no-op forever, since the unique constraint above would see attempt 1 as "already
dispatched." The fix: old attempt rows are deleted first, which is what makes "reset
to 1" actually true.

**Deleting a job** (`delete-job.ts`) soft-deletes the `Job` row (same `deletedAt`
convention every query filters on — reversible, keeps cost/audit history) but
**hard-deletes every real Cloudinary asset** the job touched, including every
failed/retried attempt's own image, not just the ones linked to the final result.
Best-effort (`Promise.allSettled`) — one bad URL doesn't block the rest.

---

## 8. Data model

4 tables, 3 enums (`apps/api/prisma/schema.prisma`).

```
Job ──< StageAttempt        (every attempt of every stage, pass or fail, all kept)
    ──< DimensionJob         (one row per aspect ratio, once approved)
    ──1 ApprovalLog          (the one human decision, if it's happened yet)
```

| Field (Job) | Purpose |
|---|---|
| `status` | Current `JobStatus` — see the 13-value enum below |
| `reference1Url` / `reference2Url` / `logoUrl` / `prompt` | The 4 original inputs |
| `baseAssetUrl` | The "current best base image" — written by `base_asset`, then overwritten by `logo_composite` |
| `posterUrl` | The approved (or awaiting-approval) 1:1 poster |
| `baseLayerSpecJson` | Cached `base_layer_classification` output, written once |
| `styleSpecJson` | Present in the schema from an earlier cached-extraction design; **not currently written** — style extraction is uncached per attempt today |
| `name` | User-editable display name (dashboard rename feature) |
| `deletedAt` | Soft-delete marker |

`StageAttempt` has a `@@unique([jobId, stage, attemptNumber])` constraint — this *is*
the idempotency lock described in §7. Also carries `assetUrl` (every attempt's image,
not just the winning one), `qaReasoning`, `boundingBoxJson` (the logo's placed box),
and `layerBreakdownJson` (diagnostic: the style spec + generated copy that actually
drove a given poster attempt).

**`JobStatus`** (13 values): `QUEUED → BASE_LAYER_CLASSIFYING → BASE_ASSET_GENERATING
(→ BASE_ASSET_SCORING mid-stage) → LOGO_PLACEMENT_DETECTING → LOGO_COMPOSITING →
POSTER_GENERATING → AWAITING_APPROVAL → DIMENSION_EXPANDING → COMPLETE`, with
`NEEDS_ATTENTION` and `REJECTED` reachable from most points along the way.

**`StageAttemptResult`**: `PASS` / `RETRY` / `ESCALATED`.
**`DimensionStatus`**: `PENDING` / `GENERATING` / `SCORING` / `DELIVERED` /
`NEEDS_ATTENTION`.

---

## 9. Queues, workers, and providers

Two BullMQ queues, each throttled independently so a rate limit on one provider never
blocks the other:

- **`image-generation`** — every Gemini call (`base_asset`, `dimension_*`).
- **`vision-scoring`** — every GPT-4.1 call (`base_layer_classification`, every
  `scoreImage`, logo position, style extraction, ad copy).

Deterministic stages (`logo_composite`, `poster`) **never touch a queue at all** —
they run inline from the Orchestrator (§7).

`workers/pipeline-worker.ts` is the one generic processor shared by both queues: look
up the stage definition, call its `execute()`, hand the result to
`handleStageResult()`. A `ScoringFailedError` (generation succeeded, real money
spent, but the *scoring* call itself threw — usually a broken vision key) is
special-cased: the BullMQ job is discarded after one attempt and escalated
immediately, rather than silently burning 2 more identical, doomed, paid retries.

Provider clients (`providers/`):
- **`gemini.client.ts`** — one `generateImage()` function. Reference images are
  attached as labeled parts (an unlabeled image was confirmed to get silently
  ignored). Cost is a static per-model lookup, not a live billing-API query.
- **`openai.client.ts`** — the largest file (~935 lines). Every chat-completions call
  (scoring, position detection, classification, copy, style analysis) goes through
  one shared `callChatModel()` (JSON mode). `editPosterImage()` is the one
  differently-shaped call — real `multipart/form-data` against `/v1/images/edits`
  using native `FormData`/`Blob` (no OpenAI SDK installed), with its own 120s
  timeout enforced by both axios's own `timeout` *and* an `AbortController`
  (axios's own timeout alone was confirmed unreliable under Bun once multiple images
  were attached).
- **`cloudinary.client.ts`** — uploads via a base64 data URI, not the SDK's
  `upload_stream()` (confirmed by reproduction: streaming silently breaks on Bun once
  a buffer crosses ~2MB, which every real pipeline asset does).

`lib/http-client.ts` wraps every provider call in a shared Axios retry layer —
exponential backoff with jitter on network errors/429/5xx, `maxRetries: 3`. This is
the **technical**-failure retry from §3, entirely invisible to and never counted
against the content-quality budget.

---

## 10. Realtime layer & API

**Socket.IO** (`realtime/`) — one `Server` instance, one `GLOBAL_ROOM`. Per-job
events (`job:status_changed`, `job:approval_requested`) are scoped to that job's own
room only; `job:needs_attention`, `job:completed`, `feed:job_created`, and
`feed:job_deleted` also reach the bounded global room, since those change what the
dashboard's job list/queue looks like. `job:approval_response` (client → server) is
handled by the same `approveJob`/`rejectJob` functions the REST fallback uses, so the
two paths can never diverge in behavior.

**REST API** (`routes/jobs.routes.ts`), 8 endpoints:

| Method & path | Does |
|---|---|
| `POST /api/v1/jobs` | Uploads the 3 files + prompt, creates the `Job`, dispatches `base_layer_classification` |
| `GET /api/v1/jobs` | Paginated list, filterable by `status`, carries `name`/`prompt` directly (fixed a real N+1 — the dashboard used to fetch full detail per row just to render a preview) |
| `GET /api/v1/jobs/:id` | Full detail incl. every `StageAttempt`, `DimensionJob`, `ApprovalLog` |
| `POST /api/v1/jobs/:id/approve` | Human approves → dimension expansion begins |
| `POST /api/v1/jobs/:id/reject` | Human rejects (optional comment) → terminal |
| `POST /api/v1/jobs/:id/retry` | Resets an escalated stage and re-dispatches it |
| `PATCH /api/v1/jobs/:id` | Renames the job's display name |
| `DELETE /api/v1/jobs/:id` | Soft-delete + real Cloudinary cleanup |

---

## 11. The dashboard

React 18 + Vite + TanStack Query + Tailwind v4, internal test UI only
(`apps/dashboard`). Not a polished product surface — a real working tool for
watching and steering live jobs.

- **`App.tsx`** — top bar with a live "Live"/"Disconnected" socket status dot.
- **`JobList.tsx`** — collapsible sidebar (340px ↔ 62px), All/Attention/Complete
  filter tabs, inline rename and delete (optimistic, with rollback on error), fully
  socket-driven live updates.
- **`JobTrace.tsx`** — the job detail view: reference/logo thumbnails, a live
  pipeline trace (`base_asset → logo_composite → poster`, each showing every
  attempt with its QA score/reasoning/cost), the approval card, the 3-dimension
  results grid, and a **"Regenerate with changes"** panel — which, importantly,
  **starts a brand-new job** re-using the same 3 reference files with a follow-up
  note appended to the original prompt. It does not live-steer an in-flight job;
  no backend endpoint accepts new prompt text for an existing job.
- **`StageStep.tsx`** — correctly distinguishes an in-flight placeholder attempt
  (`completedAt === null`, written the instant a stage is dispatched) from a
  genuinely failed one, since the placeholder's literal `result: 'RETRY'` value
  would otherwise read backwards.
- **`BoundingBoxImage.tsx`** — overlays the logo's detected placement box on the
  actual image, so the AI's decision is visually checkable, not just a number in a
  tooltip.

Note: the dashboard's pipeline trace shows 3 steps (`base_asset`, `logo_composite`,
`poster`) — `base_layer_classification` runs before any of these and isn't rendered
as its own trace row.

---

## 12. Running it

```bash
bun install
bun run dev:api          # Express + BullMQ workers + Socket.IO, apps/api/src/server.ts
bun run dev:dashboard     # Vite dev server, apps/dashboard
bun test                  # every workspace's test suite
```

Required live services: Postgres (Supabase — `DATABASE_URL` is the pooled runtime
connection, `DIRECT_URL` is the direct connection used only for migrations), Redis
(`REDIS_URL`), and real `GEMINI_API_KEY` / `OPENAI_API_KEY` / `CLOUDINARY_*`
credentials. Every provider call fails loudly and immediately if its key or model env
var is missing — never a silent fallback.

Migrations: `cd apps/api && bunx prisma migrate dev && bunx prisma generate`.

---

## 13. Known gaps / not yet built

- `dimension_*` is still a full AI regeneration of the finished poster (§4.5) — the
  safer "extend the clean photo, re-run the deterministic steps on the new canvas"
  design has been discussed but not built.
- `GEMINI_FLASH_MODEL` is configured but not used by any stage today — every
  generation call uses Pro.
- Style extraction (`analyzeReferenceStyle`) is deliberately uncached per poster
  attempt right now, despite `Job.styleSpecJson` still existing in the schema from an
  earlier cached-extraction design.
- No auth, no multi-tenancy, no deployment config — internal, single-instance, v1.
