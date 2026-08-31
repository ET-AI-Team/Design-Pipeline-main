# Design Pipeline — Complete Project Reference

_Written 2026-08-30, from a full line-by-line read of every source file in `apps/api`,
`apps/dashboard`, and `packages/shared-types` — including the uncommitted work
currently sitting in the working tree. This is not a summary of a summary; every
claim below was checked directly against the code as it exists right now. The
codebase has historically changed substantially every few days throughout August
2026 — if you're reading this much later, re-verify anything load-bearing against
source rather than trusting a file:line reference blindly. The user's own stated
policy for this repo: **the code is the true progress record, not any doc** — when
a doc and the code disagree, trust the code._

---

## 1. What this project actually is

This is an internal automation tool for producing finished advertising creative.
A human supplies four inputs through a small internal dashboard:

1. **Reference image 1** — subject/scenario direction (what kind of photo, what mood)
2. **Reference image 2** — layout reference (the actual design to match: text
   structure, colors, hierarchy, background treatment)
3. **A brand logo file** (PNG or SVG)
4. **A text brief** (10–2000 characters) describing the campaign

From those four inputs, the system runs an unattended, multi-stage AI pipeline that:

- generates a brand-new photographic base image matching the reference's
  photographic style and composition (never copying the reference's actual
  content/people/text)
- places the real brand logo onto that photo at an AI-chosen, code-validated position
- composites all the campaign's real ad copy (headline, subtext, CTA button, trust
  points, price, badges) onto the photo as one finished 1:1 square poster, matching
  the reference's layout structure as closely as possible
- stops and waits for a **human approval checkpoint** on that one poster
- once approved, automatically re-composes the approved poster into three more
  aspect ratios (9:16, 4:5, 1.91:1) **in parallel**

Every single AI generation or edit step in this pipeline is graded by a **different
model than the one that produced it** — never self-graded. A failing grade
triggers an automatic retry with the specific failure feedback folded into the next
attempt's prompt, up to a small retry cap; if it still fails, the job (or, for
dimension expansion, just that one dimension) is escalated to a "Needs Attention"
queue a human can look at and manually retry from the dashboard.

This is explicitly an **internal production tool**, not a customer-facing product —
the dashboard is described in its own code comments as "internal test UI only."

---

## 2. Technology stack

A Bun workspaces monorepo with three packages:

### `apps/api` — the backend
- **Express** for the HTTP API
- **BullMQ** (backed by **Redis**, via `ioredis`) for the async job queue that
  drives AI-generation and vision-scoring calls
- **Prisma** ORM against **PostgreSQL**, hosted on **Supabase** (the schema
  explicitly documents a pooled `DATABASE_URL` for runtime queries and a
  non-pooled `DIRECT_URL` for migrations, since Supabase recommends bypassing its
  connection pooler for schema changes)
- **Socket.IO** for realtime push (job status changes, approval requests, needs-
  attention flags, completion, live feed events) to the dashboard
- **Pino** (+ `pino-http`) for structured JSON logging, with an explicit redaction
  list protecting API keys and auth headers from ever landing in a log file
- **sharp** for all deterministic image manipulation (resizing, cropping,
  compositing, square-canvas enforcement)
- **axios** as the one shared HTTP client for both AI providers (no official SDK
  for either OpenAI or Gemini is installed — every provider call is raw HTTP)
- **multer** for multipart file upload handling
- **cloudinary** SDK for asset storage
- **zod** for request validation

### `apps/dashboard` — the frontend
- **React 18** + **Vite** + **TypeScript**
- **TanStack Query** for all server state (jobs list, job detail), with careful
  optimistic-update / rollback patterns on delete and rename
- **Tailwind v4** (via `@tailwindcss/vite`, not the older PostCSS plugin) for styling
- **socket.io-client** for the same realtime channel the backend exposes
- A small local `components/ui/*` primitive set (Badge, Button, Card, Input,
  Label, Textarea) — not a full external design-system dependency
- `lucide-react` for icons

### `packages/shared-types` — the contract package
- Pure **Zod schemas + TypeScript types + enums**, imported by both apps as
  `@pipeline/shared-types` (a Bun workspace package, not published anywhere)
- The **single source of truth** for: `JobStatus`/`StageAttemptResult`/
  `DimensionStatus` enum values, the three dimension names, every Socket.IO event
  payload shape (both directions), and the job-creation/rename/list-query
  validation schemas
- Nothing here is architecture-specific to either app — it's the seam that keeps
  the backend and frontend from silently drifting apart on what a status string or
  a socket payload actually looks like

There is **no Playwright and no server-side HTML rendering anywhere** in this
codebase. Per the project's own memory/history, that was an earlier architecture
generation that has been fully and completely abandoned — every trace of it is gone
from the current source, not just deprecated.

---

## 3. Data model (`apps/api/prisma/schema.prisma`)

Four tables, all Postgres via Prisma, no soft-delete cascades (soft-delete is
handled explicitly in application code, not at the schema level).

### `Job` — the root entity, one row per submitted campaign
- `id` (UUID), `name` (nullable, user-editable display name — the UI falls back
  to showing the raw `prompt` when unset)
- `status` — the `JobStatus` enum (13 values, see §5 below), defaults to `QUEUED`
- `reference1Url`, `reference2Url`, `logoUrl` — the three uploaded files, stored on
  Cloudinary
- `prompt` — the raw campaign brief text
- `baseAssetUrl` — the current best base photo. **Both** `base_asset` and
  `logo_composite` write to this same field on pass — whichever stage most
  recently produced a valid base image is what every downstream stage reads. (A
  real, since-fixed bug: `logo_composite` passing was originally never wired to
  update this field at all, so the logo never actually reached anything a human or
  the poster stage saw — every downstream consumer kept reading the pre-logo image.)
- `posterUrl` — the approved 1:1 poster, once the `poster` stage passes
- `styleSpecJson` — the extracted `PosterStyleSpec` (see §7), cached on the Job row
  so every poster retry within the same job can reuse or selectively re-verify it
  rather than re-deriving it from scratch every time
- `baseLayerSpecJson` — the extracted `BaseLayerSpec` from
  `base_layer_classification`, written once on that stage's pass and read by
  `base_asset`'s prompt builder — replaces an old hardcoded "subject right-two-
  thirds, clean left-third" assumption with a genuine per-job read of the
  reference's actual composition
- `createdAt`, `updatedAt`, `deletedAt` (soft-delete marker — every list/lookup
  query filters `deletedAt: null` explicitly)
- Relations: many `StageAttempt`, many `DimensionJob`, one optional `ApprovalLog`
- Indexes on `status` and `createdAt`

### `StageAttempt` — one row per (job, stage, attempt number)
- Unique on `[jobId, stage, attemptNumber]` — this uniqueness constraint is also
  what makes stage dispatch **idempotent**: `dispatchStageJob()` tries to create
  this row first, and a duplicate dispatch just hits the unique-constraint error
  and silently no-ops rather than firing a second paid provider call.
- `modelUsed`, `latencyMs`, `costInr`, `qaScore` (nullable Decimal), `qaReasoning`
- `boundingBoxJson` — only ever populated when `stage === 'logo_composite'`: the
  real placed `{x, y, width, height}` box, persisted so a retry (or the poster
  stage, later) can read back the AI-detected placement instead of re-deriving or
  guessing it.
- `layerBreakdownJson` — only populated by `stage === 'poster'`: the extracted
  `PosterStyleSpec` + generated `AdCopy` + per-field verification result for THAT
  specific attempt. This is the mechanism that lets a poster retry pin whichever
  copy fields already passed instead of regenerating everything from scratch (see
  §7.6 below — this is one of the more subtle, most-iterated-on pieces of the
  whole system).
- `assetUrl` — every attempt's generated image is uploaded to Cloudinary and kept
  here regardless of pass/fail. (A real, since-fixed gap: this used to only be kept
  if the attempt happened to be the one that passed — every failed/retried
  attempt's image was uploaded then effectively lost, unretrievable through the
  API even though it still physically existed on Cloudinary.)
- `result` — `PASS` | `RETRY` | `ESCALATED`
- `startedAt`, `completedAt` (nullable — null means still in flight; the dashboard
  uses this specifically to distinguish "in progress" from a literal `RETRY`
  placeholder value that would otherwise misleadingly read as "already failed")
- Indexed on `jobId`

### `DimensionJob` — one row per (job, dimension), created only after approval
- `id`, `jobId`, `dimension` (one of `"9x16"`, `"4x5"`, `"1.91x1"`)
- `status` — `PENDING` | `GENERATING` | `SCORING` | `DELIVERED` | `NEEDS_ATTENTION`
- `assetUrl`
- Indexed on `jobId`

### `ApprovalLog` — at most one per job
- `id`, `jobId` (unique), `decision` (`"approve"` | `"reject"`), `comment`
  (nullable — only meaningful on reject), `decidedAt`

---

## 4. Repository layout

```
apps/api/src/
  app.ts, server.ts              — Express app assembly + process entrypoint
  lib/
    db.ts                        — Prisma singleton (dev-mode global cache, avoids
                                    connection-pool exhaustion under bun --watch)
    env.ts                       — requireEnv(): fail loudly on missing config,
                                    never a hardcoded model-string fallback
    http-client.ts               — shared axios factory: auto-retry on 429/5xx/
                                    network error with exponential backoff+jitter,
                                    invisible to and never counted against the
                                    orchestrator's own content-quality retry budget
    logger.ts                    — Pino config incl. redaction of API keys/auth
                                    headers from log output
    api-error.ts                 — the one error type route handlers throw
  middleware/
    validate.ts                  — generic Zod-schema validation middleware
    error-handler.ts             — the one place ApiError becomes an HTTP response
  routes/
    jobs.routes.ts                — the entire REST surface (see §10)
  orchestrator/
    types.ts                      — StageDefinition / StageResult contracts
    stage-registry.ts             — in-memory Map<name, StageDefinition>
    handle-stage-result.ts        — the core PASS/RETRY/ESCALATE decision engine
    run-deterministic-stage.ts    — logo_composite + poster stage bodies (~500 lines,
                                     the most complex file in the repo)
    poster-text-edit.ts           — the poster's full-context edit prompt/rubric
                                     builder (~870 lines, second most complex file)
    render-poster.ts              — PosterStyleSpec extraction + clamping/caching
    logo-placement.ts             — deterministic logo sizing/position-clamping math
    dimension-orchestrator.ts     — post-approval fan-out + completion aggregation
    delete-job.ts                 — soft-delete Job + hard-delete every Cloudinary asset
    retry-stuck-job.ts            — manual "Retry" button backend logic
  stages/
    index.ts                      — side-effect import barrel, registers every stage
    base-layer-classification.stage.ts
    base-asset.stage.ts
    logo-composite.stage.ts       — thin: just registers the stage name as deterministic
    poster.stage.ts               — thin: same
    dimension.stage.ts            — registers all 3 dimension stages in a loop
    generate-and-score.ts         — shared generate→upload→score routine used by
                                     base_asset and all 3 dimension stages
  providers/
    gemini.client.ts              — image generation (generateImage)
    openai.client.ts              — everything else AI (~1150 lines: vision scoring,
                                     logo position detection, ad-copy generation,
                                     style extraction, base-layer classification,
                                     poster edit + verification)
    cloudinary.client.ts          — upload/delete/public-id-recovery
  queues/
    queue-definitions.ts          — the two BullMQ Queue instances + StageJobPayload
    dispatch.ts                   — dispatchStageJob(): idempotent enqueue
    stalled-job-config.ts         — shared BullMQ WorkerOptions (lockDuration etc.)
  workers/
    pipeline-worker.ts            — the two BullMQ Workers; routes a dequeued job to
                                     its StageDefinition.execute() and hands the
                                     result to the orchestrator
  realtime/
    socket-server.ts              — Socket.IO server attach + room join/approval-
                                     response listener
    emitters.ts                   — the ONLY place server→client events are emitted
                                     from
    approval-handler.ts           — approveJob/rejectJob business logic

apps/dashboard/src/
  App.tsx                         — shell: sidebar + main pane, connection-status dot
  components/
    Composer.tsx                  — the "new job" submission form
    JobList.tsx                   — the sidebar: filterable list, rename/delete,
                                     optimistic updates, live socket sync
    JobTrace.tsx                  — the main job-detail view: full pipeline trace,
                                     approve/reject UI, dimension grid, "regenerate
                                     with changes" follow-up flow
    StageStep.tsx                 — one stage's row within JobTrace (attempt history,
                                     retry button)
    BoundingBoxImage.tsx, ImageLightbox.tsx — image display helpers
    ui/*                          — local button/badge/card/input/label/textarea primitives
  lib/
    types.ts                      — frontend-local types + PIPELINE_STAGES/
                                     STAGE_LABELS/stageDisplayStatus derivation logic
    socket.ts                     — the socket.io-client singleton
    utils.ts                      — cn(), relativeTime(), unwrapJson()

packages/shared-types/src/
  enums.ts                        — JobStatus, StageAttemptResult, DimensionStatus,
                                     DIMENSION_NAMES
  socket-events.ts                — every socket payload shape, both directions
  schemas/job.schema.ts           — CreateJobSchema, RenameJobSchema, ListJobsQuerySchema,
                                     file-type/size constants
  schemas/envelope.schema.ts      — standard success/error response envelope + ErrorCode
```

---

## 5. The `JobStatus` state machine

Thirteen values, defined once in `packages/shared-types/src/enums.ts` and reused
verbatim by the Prisma schema, the dispatch/status logic, and the dashboard:

```
QUEUED
  → BASE_LAYER_CLASSIFYING
  → BASE_ASSET_GENERATING → BASE_ASSET_SCORING
  → LOGO_PLACEMENT_DETECTING → LOGO_COMPOSITING
  → POSTER_GENERATING → POSTER_SCORING
  → AWAITING_APPROVAL  ── human checkpoint, no timeout ──┐
                                                          ↓
                                              DIMENSION_EXPANDING
                                                          ↓
                                                      COMPLETE

Any active stage can instead terminate into:
  NEEDS_ATTENTION   (a stage exhausted its content-quality retries)
  REJECTED          (human rejected at the approval checkpoint)
```

`statusForStage()` (`handle-stage-result.ts`) is the single place this stage-name
→ status-enum mapping lives — deliberately typed against the real Prisma
`JobStatus` enum rather than a bare `string`, which a real bug once caught as a
genuine TypeScript error under strict mode when it wasn't.

`LOGO_PLACEMENT_DETECTING` is emitted manually, mid-execution, by
`run-deterministic-stage.ts`'s logo compositing function — it isn't tied to a
separately-registered stage name, because (see §6.2) logo detection and
compositing are one folded unit, not two stages.

---

## 6. The pipeline stages, in execution order

### 6.1 `base_layer_classification` (vision, queued on `vision-scoring`)

The very first stage, dispatched synchronously inside the job-creation route
handler (before the HTTP response for job creation is even sent, though not
awaited to completion). Calls `classifyBaseLayer()` (`openai.client.ts`), a GPT-4.1
vision call against **two** images: Reference-02 (the layout reference, classified
directly) and Reference-01 (subject/mood direction only, used as context, never
classified from directly).

This stage replaced an earlier, fully-abandoned design that forced every reference
into one of a small fixed set of composition "archetypes" plus a locked
percentage-based `exclusionZone` box, trusted blindly before the actual generated
photo even existed. The current design produces a `BaseLayerSpec` made entirely of
**freeform descriptive prose**, not categories or numbers:

- `compositionGuide` — a detailed paragraph describing specifically where the
  subject sits, where the eye finds clean/uncluttered space, and how the two
  relate — written to be specific enough that someone using *only* this
  description could generate a brand-new photo of a completely different subject
  that still composes the same way. The prompt explicitly distinguishes two shapes
  of composition (subject-to-one-side vs. a centered clean band above/below the
  subject) and, for the centered-band case, insists any secondary background
  element within that band be described as sitting **off-center**, not merely
  faded — a real defect found live: fading a dead-center element's contrast alone
  still blocks centered text passing directly through the frame's true middle.
- `backgroundTreatment` — any non-text, non-logo design element (a color block, a
  gradient, a textured surface) the reference uses that isn't simply what the
  camera captured. Text of any kind — even a giant faded background wordmark — is
  explicitly excluded from this field (that's `poster`'s job, see §7), **except**
  that a genuine non-text *container* the lettering happens to sit on (a color
  block, a diagonal panel) must still be described here even when a wordmark sits
  on top of it. This exact carve-out (container yes, lettering no) is one of the
  pieces of uncommitted work currently in the tree — see §12.
- `photoStyle` — `{colorGrading, lighting, setting, framing}`, read directly off
  the actual reference rather than generalized from fixed constants. (Real defect
  found live and fixed: `base_asset` used to generate everything except geometry
  from hardcoded constants regardless of what the reference actually looked like —
  a warm/golden, tight-framed reference produced a cool/neutral, wide-framed
  result: right composition archetype, completely wrong photographic identity.)
- `notes` — one free-text debugging sentence, never read by any downstream logic.

Validation (`base-layer-classification.stage.ts`) is deliberately minimal —
there's no fixed category or numeric range left to check against anymore, only
"is every required string field non-empty" (an empty `backgroundTreatment` is
explicitly *valid*: "no treatment" is a real, legitimate answer). On pass, the
whole spec is persisted to `Job.baseLayerSpecJson`.

### 6.2 `base_asset` (image generation, queued on `image-generation`)

Builds a structured prompt (`buildBaseAssetPrompt` → `serializeBaseAssetPrompt` in
`base-asset.stage.ts`) combining: the raw campaign brief (as scene/subject/mood
direction, explicitly **not** verbatim ad copy — a repeated instruction says to
ignore any text/CTA/headline content the brief describes), the cached
`BaseLayerSpec`'s composition/background/style guides, and a fixed "realism block"
(visible skin texture, natural asymmetry, no retouching/beauty-filter/AI-look —
paired with an equally explicit negative list).

Both realism and the "no text anywhere" negative constraint are **bookended** —
stated at the top of the prompt and repeated again at the very end — because a
single mention was confirmed live to lose against a brief that had its own
explicit copy described in it (Gemini rendered the poster's actual text into the
base photo despite one negative instruction). The negative-constraint list also
specifically tells the model to **omit the whole object** rather than render it
blank when the scenario implies a text-bearing prop (a race bib, name tag, sign) —
an earlier version only said "no text," and the model dutifully rendered a
blank, unnaturally sharp-edged rectangle exactly where such an object's text would
have gone, on every subject in a real generated photo.

Generates via `generateImage()` (Gemini Pro model — deliberately switched off Flash
because the classifier-informed structured prompt is a harder instruction-
following task than Flash was validated against), attaching **both** reference
images with distinct roles (subject direction vs. style-to-match).

`enforceSquareCanvas` in `generate-and-score.ts` center-crops back to square if
Gemini ignores the "1:1 square" instruction (a real, live-observed failure — one
generation returned 1408×768 despite the explicit ask). This only ever applies to
`base_asset`; the three `dimension_*` stages legitimately generate non-square
output and must never have it applied.

Scored via `scoreImage()` against `buildBaseAssetRubric()` — a **dynamic**, per-job
rubric built from the same spec the generation itself targeted (composition,
background treatment, color/lighting/setting/framing), plus both real reference
images attached for the judge to compare against directly, rather than a single
fixed "does it look photorealistic" bar that can't distinguish a reference's
deliberately stylized/duotone treatment from a genuine defect.

The rubric also carries a specific **text vs. incidental-environmental-text**
distinction: fabricated ad-copy-shaped text (a headline phrase, a CTA, a price, a
brand wordmark not in the references) is an automatic fail, but authentic
incidental text that's a natural part of a real scene (carved inscriptions on a
real monument, distant signage) consistent with the references is explicitly *not*
a failure — because this pipeline composites all real campaign copy in a separate
later stage and needs the base photo to be a clean canvas, but shouldn't punish
photorealism for containing the kind of text a real unedited photo of that scene
would actually have.

**Currently in progress (uncommitted):** `buildBaseAssetRubric` now also takes
`campaignBrief` and runs a separate **content checklist** pass — reading the brief
for concrete, unambiguous nouns it names (a specific person/role, an explicit
visible prop or detail, a stated count) and checking the actual image for each one,
independent of and prior to the style judgment. This closes a real, confirmed
defect: the old rubric never once looked at the brief, so a job that asked for "an
elderly grandmother" with "race bibs on every runner" generated a photo with
neither, and scored 9/PASS anyway because composition and lighting looked fine.
The checklist is deliberately scoped to concrete nouns only — mood/style language
("energetic," "premium," "cinematic") is explicitly excluded, since that's already
judged by the style comparison and would make an inherently subjective quality into
a literal pass/fail item if included here.

### 6.3 `logo_composite` (deterministic, runs inline — not through the queue)

This is **one folded stage**, not two — an earlier design split "detect logo
position" and "composite the logo" into separately registered stages, but that ran
into a real mechanical conflict: the orchestrator's generic retry path always
dispatches the *next* stage fresh at `attemptNumber: 1`, which collides with a
retryable stage's own `(jobId, stage, attemptNumber)` uniqueness constraint the
moment it needs a second attempt. More fundamentally: re-placing the logo at the
exact same AI-chosen coordinate on a retry would fail identically every time — the
position decision and its execution have to retry together as one unit, so a
failed post-placement QA can genuinely ask for a **new** coordinate on the next
attempt, not just re-render the same wrong one.

Implementation (`runLogoCompositeStage` in `run-deterministic-stage.ts`):
1. Fetches the current `baseAssetUrl` and the real logo file buffer (plus, on a
   retry, the previous attempt's own QA feedback text from the DB — this stage
   never flows prompt feedback through `buildPrompt()`, since it's deterministic
   and never queued).
2. `computeLogoDimensions()` (`logo-placement.ts`) sizes the logo deterministically
   — aspect-ratio-preserving, width-driven at 22% of canvas width unless that would
   exceed an 11%-of-canvas-height cap, in which case it falls back to a height-
   driven size. **Position is never computed deterministically** — only size.
3. `detectLogoPosition()` (`openai.client.ts`) is a GPT-4.1 vision call against the
   real generated photo, handed every deterministic constraint explicitly as
   numbers (canvas size, the logo's already-fixed size, a starting margin
   *suggestion*, and a hard `topAreaMaxY` the logo's top edge must stay within) and
   asked for one exact `{x, y}` coordinate. This replaced an even earlier 3-bucket
   left/center/right design with a separate pixel-clutter heuristic correcting it
   after the fact — the model now has the same information a human placing the
   logo by eye would have, rather than guessing a bucket from a text description.
4. `clampLogoPosition()` never trusts that coordinate blind — it's clamped into the
   real valid range for the canvas/logo size (not rejected outright; a
   slightly-out-of-bounds or non-finite value is silently clamped rather than
   burning a whole retry over it).
5. The actual pixel composite uses `sharp`'s `fit: 'contain'` (never `'cover'` —
   `'cover'` crops to fill the box exactly, which is correct for photos but was
   confirmed live to badly mangle a wide/short logo forced into a near-square
   detected box: blown up and cut off at the canvas edge). Upscaling uses
   `kernel: 'lanczos3'` plus a light `sharpen({sigma: 0.6})` pass — most uploaded
   logos are small relative to the detected box, so this resize is usually an
   upscale, and even a modest ~1.4× enlargement visibly softened edges without
   these.
6. The **whole composited image** (not just the geometric placement) is scored via
   `scoreImage()` against a rubric checking natural/intentional placement, full
   legibility, and nothing important covered — a placement can be geometrically
   valid (in-bounds, in the top area) and still look awkward or cover something
   important, which only a look at the real composited pixels can catch. (An
   earlier version gave this stage an unconditional pass with no real QA at all.)

This stage's rendering approach is explicitly **paint-nothing**: no backdrop panel
or background treatment is ever drawn here — that's entirely `base_asset`'s job to
bake directly into the photo generation. `logo_composite` only resizes and places
the real logo pixels. On pass, the composited URL is written back to the shared
`Job.baseAssetUrl` field (see §3 — the field both `base_asset` and `logo_composite`
write to).

### 6.4 `poster` (deterministic, runs inline) — the most-rewritten stage

See §7 below — this is complex enough to deserve its own top-level section.

### 6.5 Human approval checkpoint (`AWAITING_APPROVAL`)

No timeout. The dashboard shows the poster image with Approve/Reject buttons.
Approval flows over the **Socket.IO** channel, not a REST call (`job:approval_response`
→ `socket-server.ts` → `approval-handler.ts`'s `approveJob`/`rejectJob`) — though a
REST fallback (`POST /:id/approve`, `/:id/reject`) exists too and calls the exact
same functions.

- **Approve** → records an `ApprovalLog` row, flips status to
  `DIMENSION_EXPANDING`, and calls `onApproved()` (`dimension-orchestrator.ts`),
  which creates all three `DimensionJob` rows and dispatches all three dimension
  stage attempts **genuinely in parallel** (`Promise.all`, not sequential).
- **Reject** → records the `ApprovalLog` (with an optional comment), flips status
  to `REJECTED`. Terminal — there's no automatic re-attempt path; the dashboard's
  "regenerate with changes" flow (see §11) is the actual recovery path, and it
  works by starting a **brand new job**, not resuming this one.

### 6.6 `dimension_9x16`, `dimension_4x5`, `dimension_1.91x1`

All three registered from one loop in `dimension.stage.ts` (via
`DIMENSION_NAMES` from shared-types — the single place that list is defined).
Each is a `generateAndScore()` call (same shared routine `base_asset` uses) asking
Gemini to *recompose* the approved poster into the new aspect ratio — extending the
background naturally, never stretching the subject, with an explicit "must read as
one continuous photograph, no visible seam" instruction, referencing the poster
image directly as the input. Scored on the same seam/blend criteria.

Model is `GEMINI_PRO_MODEL` throughout — the code comment notes an intended future
A/B test to see if the cheaper Flash model meets the same bar for this
specifically (dimension recomposition is a lower-fidelity task than the original
generation), but that test is explicitly **not yet run**; Pro is the confirmed
fallback in the meantime, and switching later is a one-line change.

Each dimension is **independently retryable and independently escalatable** — one
dimension failing all its attempts moves *only that dimension* to
`NEEDS_ATTENTION` and never blocks the other two from completing
(`escalateToNeedsAttention`/`checkForCompletion` in the orchestrator). The parent
`Job` only flips to `COMPLETE` once every `DimensionJob` child has reached a
terminal state (`DELIVERED` or `NEEDS_ATTENTION`) — partial delivery is a first-
class supported outcome, not an edge case.

---

## 7. Deep dive: the `poster` stage

This is the single most-iterated-on part of the entire system. Per the project's
own memory, it has been **rewritten four separate times**:

1. **Gen 1** (original design) — Gemini regenerated the *entire* poster from
   scratch, with text baked in by the image generator itself.
2. **Gen 2** — moved to deterministic sharp/resvg SVG rendering of AI-written copy
   directly onto the base photo. No image-generation model touched the text at all.
3. **Gen 3** ("Layered Text-Composition Architecture") — masked, per-layer
   `gpt-image-2` edits: headline+subtext, CTA, and trust-list as three separately
   masked regions, with two-tier (per-layer, then holistic) verification.
4. **Gen 4 — current** — a **single full-context edit with no mask at all**. One
   `gpt-image-2` call sees the whole photo+logo composite at once, plus real
   reference-image crops of specific style elements, and is trusted with an
   extremely detailed prompt describing exactly what must stay unchanged and
   exactly what to add — rather than a hard pixel boundary enforcing it
   structurally. This tradeoff is explicit and deliberate in the code comments: the
   old mask gave a technical guarantee the photo/logo couldn't be touched; the
   current design gives that guarantee up in exchange for a simpler, more directly
   controllable single generation step, and leans on prompt specificity plus the
   downstream QA gate to catch a violation instead of making one structurally
   impossible.

### 7.1 `PosterStyleSpec` — the extracted design contract

Produced by `analyzeReferenceStyle()` (`openai.client.ts`), a GPT-4.1 vision call
against **three** images: the reference (content/hierarchy/structure), the actual
current photo+logo composite (for size ratios judged against the *real* canvas,
which may differ in size from the reference), and the real uploaded logo file
(purely so the model can recognize when some other element in the reference is
just a restated copy of the same brand identity and should be excluded, never
copied as fresh content).

This is deliberately **not** a fixed template. Two real references confirmed
structurally different, not just differently colored: one had headline + subtext +
CTA pill + a full-width footer bar; another had a 4-line headline with one
highlighted line, no CTA at all, and a card of trust items ending in a highlighted
price row. The spec captures, per job:

- `marginXRatio`, per-gap spacing ratios (all fractions of canvas width/height, so
  they generalize across differently-sized canvases)
- `headline` — line count, alignment, and **per-line** independent style
  (`fontSizeRatio`, `fontWeight`, a rich freeform `styleDescription`, `ColorSpec`
  which can be solid or gradient). Per-line, not whole-headline, because a real
  reference had a lighter lead-in line followed by a completely different bold
  display-font punchline line — an earlier one-style-for-the-whole-headline design
  rendered both lines identically.
- `subtext`, `cta` (with an optional second price band inside the same button),
  `trustList` (deliberately *not* assumed to be checkmarks — `layoutDescription`
  is the authoritative freeform structural description; the enum fields are hints
  layered on top of it, not a template it's forced into) — including a separate
  `promoBadge` for a standalone offer badge distinct from both the CTA and any
  price row inside a trust-list card.
- `textColumnWidthRatio` — the maximum text-column width that guarantees no
  overlap with the photo's subject; becomes a **hard boundary** in the final
  generation prompt, bookended (stated once as the main instruction, repeated again
  in the closing "do not" list) after a real defect found this number was being
  extracted and then never actually read anywhere.
- `centerXRatio` — a **direct**, independently-judged read of where centered
  content's true horizontal midpoint actually sits. This replaced deriving it from
  `marginXRatio + textColumnWidthRatio/2`, a formula built for a *different*
  purpose (keeping text off a side-by-side subject) that was confirmed live to be
  wrong by roughly 15 percentage points for a reference whose subject sits *below*
  the text rather than beside it.
- `backgroundPattern` — **new, currently uncommitted** (see §12.1): a large
  repeated/tiled word used purely as background texture (e.g. a giant outlined
  brand word tiled diagonally behind the subject). Previously had nowhere to live
  in the schema at all — unambiguously "text" so it couldn't go in
  `backgroundTreatment`, but with no single position so it didn't fit
  `otherElements`' one-chip model either — and was silently dropped.
- `otherElements[]` — the catch-all for anything that doesn't fit the named
  categories (a co-branding badge, a ribbon, a date/location chip). Each entry now
  carries a real numeric position/size anchor and is broken into ordered `parts[]`,
  each independently styled — this replaced a 100%-freeform-prose design after a
  real reference's three-part "Presented by ET / The Economic Times" badge (a
  plain label, a colored icon-box, a serif wordmark, each its own font/color, in a
  specific order) rendered as one flattened, wrongly-ordered, single-font blob
  under the old design.
- `elementOrder[]` — the reference's real top-to-bottom reading order of its
  top-level blocks, since an earlier version always rendered in a fixed
  headline→subtext→cta→trustList→otherElements order regardless of what the
  reference actually did.
- Every element that can be visually complex also carries a `VisualReference` hint
  (`recommended: boolean` + a bounding `box` in the **reference image's own**
  pixel space) — see §7.4.

**Never trusts the vision call's numbers blind.** `render-poster.ts`'s
`clampStyle()` runs every single numeric field through a defensive clamp into a
sane envelope before it's ever used — the vision call is estimating proportions by
eye, not measuring pixels, and an outlier estimate must never reach the prompt
un-checked. Colors are validated as real hex; a claimed gradient without a valid
second color silently degrades to solid rather than passing a broken descriptor
downstream; a `recommended: true` visual-reference hint without a box that can
actually back a real crop is forced back to `false`.

### 7.2 Caching and re-verification (`getOrExtractStyle`)

A real, confirmed-live bug this exists to fix: style extraction used to re-run
completely fresh on **every single retry** within one job, with zero memory of the
previous read. A genuinely ambiguous structural judgment call (does a CTA button
really exist here, or is it just a labeled banner?) flipped between attempts on the
*identical* reference image — one real job's CTA appeared, then vanished, then
relocated into an unrelated badge, across three tries.

`getOrExtractStyle()` is now three-tiered, cheapest-first:
1. **No cached style yet** (first real attempt) → fresh read.
2. **Cached style exists, nothing about the last attempt suggested the structure
   itself was wrong** → reuse verbatim, zero vision calls at all.
3. **Cached style exists AND the last attempt's field-level verification flagged
   something structural** (specifically: the `cta` or `otherElements` fields
   failing — those are the only two fields where a wrong *structural* read would
   actually show up) → re-check, but **anchored** on the previous answer via
   `analyzeReferenceStyle`'s `previousStyle` param, which instructs the model to
   confirm-or-correct rather than blind-re-guess, and explicitly not to
   re-interpret a reasonable coin-flip-close call just because it's looking again.

The extracted (and clamped) style is persisted to `Job.styleSpecJson` immediately
on every poster attempt, so the *next* attempt (if needed) reads the real,
already-committed DB value — `handleStageResult()` always re-fetches the Job fresh
before dispatching a retry, guaranteeing this write is visible in time.

### 7.3 Ad copy generation (`generateAdCopy`)

Text-only (no image), GPT-4.1. Writes headline lines, subtext, CTA label, price
text, trust items, promo badge text, and one flat array of "other element" texts —
all shaped to match the *extracted structure's* exact counts (exactly N headline
lines, exactly N trust items) rather than the model picking its own counts.

Two content-integrity rules are enforced hard in the prompt, both from real
confirmed defects:
- **Never fabricate a plausible-sounding value** when the brief doesn't actually
  supply one (a real event date, a real price) — return `null`/empty instead,
  which omits that element from the design entirely. A real generation invented
  "₹1499" with zero basis in the brief.
- **Never write a description of what a field is FOR as if it were the content**
  (literal placeholder-sounding text like "Event date" or "Event location and
  date" used as the actual rendered string) — the prompt gives an explicit test
  for this exact failure mode, since it kept reappearing in slightly different
  phrasings.

For a combined multi-part badge (e.g. a location+date pill), sibling parts are
explicitly told they're allowed to stay independently empty — an earlier version
dumped all genuine content into the first sibling and invented filler for the rest
rather than leaving a sibling blank.

**Dash stripping** (`stripDashes`/`stripDashesFromLines`) is applied
deterministically to every generated field afterward, regardless of whether the
model honored a "never use a dash" instruction (real generated output has used an
em-dash mid-headline even with an explicit instruction against it — "never trust an
instruction alone for something checkable in code" is a repeated principle across
this whole codebase). **Currently in progress (uncommitted, see §12.3):** the
replacement character now depends on whether real whitespace surrounded the
original dash — a tight, no-space dash (a genuine hyphenated compound word like
"mom-to-be") becomes a plain space, while a spaced dash (a real two-clause
separator) becomes a comma. The single-fixed-replacement version broke real
hyphenated compounds ("mom-to-be" → "mom, to, be") on a real paid run.
`stripDashesFromLines` also specifically protects the true first/last line edges
of a multi-line headline from being treated the same as a mid-sentence dash — an
earlier version deleted a dash sitting at a natural line-break point outright
instead of converting it to a comma, producing "Say Goodbye to Pain Feel Relief in
Minutes" (a missing conjunction).

### 7.4 Reference crops — attaching real pictures, not just prose

`selectElementsToCrop()` (`poster-text-edit.ts`) decides which elements get
attached as real cropped reference images alongside the text prompt, in two tiers:

- **Mandatory, never trimmed**: headline (always), subtext/CTA (if present) — font
  fidelity always benefits from a real picture regardless of how "simple" the font
  looks.
- **Optional, AI-judged**: `trustList` and each `otherElements` entry, gated by
  that element's own `visualReference.recommended` flag from the extraction call,
  filling whatever budget (`MAX_REFERENCE_CROPS = 6`) the mandatory tier leaves.

This exists because a real, confirmed-live paid spike call showed an image-
generation model copies a **reference image's** visual structure (layout, color,
font, icon treatment) far more reliably than any amount of prose can describe it —
while still honoring an explicit "render only the fresh text specified, not this
image's own text" instruction. Two real elements (a multi-part co-branding badge, a
multi-zone footer) kept losing structural fidelity through prose alone no matter
how detailed the description got; attaching an actual crop closed that gap.

Crops are deterministically extracted via `sharp` against the reference image's own
*real measured* dimensions (never trusting the ratio math blind), downscaled to a
max 640px dimension and re-encoded as JPEG at quality 82 to keep the multipart
payload small — a real, deliberate cost control once mandatory font crops started
attaching on every single job. When at least one element crop is attached, a
further **full, whole-reference image** (downscaled to 768px) is also attached
purely for **scale/position judgment** — a tight crop shows an element's exact
style in isolation but throws away scale context (how big should this badge read
relative to the whole canvas), which the model was previously left reconstructing
from prose ratios alone.

The whole reference-crop mechanism **fails open**: any error fetching or cropping
the reference just results in zero crops attached (today's exact text-only
behavior), never a hard pipeline failure — this is treated as a genuinely optional
enhancement layered onto an already-working pipeline.

### 7.5 The full-context edit prompt (`buildFullContextEditPrompt`)

The single most detailed prompt in the codebase. Structural highlights:

- An explicit, **numbered manifest** of every attached image's role, stated once
  up front — including **Image 1 itself** (the actual edit target), which earlier
  versions left implicitly described while giving every reference image an
  explicit numbered role. A real defect this fixes: on a job whose reference
  happened to depict visually similar subject matter to the real photo (both
  showed runners in front of a city landmark), the model blended real details
  *from* the reference *into* the output despite a caveat sitting next to the
  reference alone — because Image 1 itself was never given the same explicit
  "this and only this is your source of photo content" treatment.
- An explicit list of everything that **already exists and must not change** — the
  photo itself, any baked-in background treatment, the established photo style,
  and (if a logo_composite attempt passed) the logo's exact pixel box.
- Instructions on how to treat the reference crops: as **templates to fill in**,
  reproducing structure/proportions/colors/icons as closely as possible, with only
  the actual text content differing — never creative reinterpretation.
- The exact copy strings to render, verbatim, quoted directly.
- **Systematic absence enforcement**: for every optional element the style spec
  says does *not* exist (no subtext, no CTA, no trust list, no icons, no promo
  badge, no price band), an explicit negative instruction is emitted — never just
  silence. A real defect: a reference with no standalone CTA (the bottom bar
  itself was the call-to-action) still got a "REGISTER NOW" button hallucinated
  onto it, because nothing forbade one and the model's own prior ("ads have
  buttons") won against silence.
- The full numeric layout instructions (`styleInstructionsBlock`) — see §7.5.1.
- A closing "do NOT" list: never alter the photo/logo or add a new physical prop
  onto the subject even if the brief describes one (the photo is already final);
  never let Image 1's own content drift toward a reference image's similar
  subject matter; never cross the hard text-column boundary; never paraphrase the
  quoted copy; never use a dash anywhere; never add unrequested decoration,
  dividers, or borders; **never add a shadow/glow to text unless that specific
  element's own extracted typography explicitly calls for one** (this replaced an
  earlier unconditional "add a shadow" instruction applied to every job regardless
  of whether the reference actually had one — a genuinely hardcoded default this
  pipeline is otherwise built to avoid everywhere else).

#### 7.5.1 `styleInstructionsBlock` — numeric, not adjectival, instructions

Deliberately describes geometry as **percentages of canvas + a concrete computed
pixel number side by side** (e.g. "22% of canvas width (~225px)"), never bare
adjectives — an image-edit model given adjectives approximates; given the same
exact ratios a deterministic renderer would use, it has a real number to target.

Several specific, non-obvious fixes live here, each traced to a real confirmed
defect:
- **`relativeSizeSentence`** — states the headline's size as a direct multiple of
  the subtext/CTA/trust-list size *within the same generation*, deterministically
  computed in code (never a second AI judgment). A correctly-identified headline
  still rendered visibly smaller than intended despite a numerically correct
  isolated percentage, because nothing anchored it against anything else in the
  same image.
- **`alignmentRule`** — bookends a real numeric center-x target (from
  `centerXRatio`) with an explicit statement of the one failure signature that must
  never happen ("every line sharing the exact same left edge" — that's left-
  alignment, not centering, even if only a small drift). This was needed after
  **two** separate confirmed-live failures: first, a bare "center-aligned" mention
  was silently ignored; then, restating it *more emphatically* as pure prose
  ("must be genuinely CENTER-aligned... do NOT render it flush left") was *also*
  confirmed to make no measurable difference — a real job's pixel-measured
  centered headline still started every line at the identical left edge. Only
  giving the model an actual coordinate to hit, the same fix already proven for
  font size and color, actually worked.
- **`textColumnBoundary`** — computed once and shared between the main layout
  statement and the closing "do NOT" bookend, so the two mentions of the same
  boundary can never numerically disagree with each other.
- **Background pattern block** — currently uncommitted, see §12.1; rendered first,
  behind everything else, as a background-layer texture with explicit instructions
  to paint over any existing garbled/blank attempt rather than preserve it.

`pickEditSize()` picks the nearest real `/v1/images/edits` size enum
(`1024x1024`/`1024x1536`/`1536x1024`) to the composite's actual aspect ratio — a
real, live-observed defect found `size: 'auto'` silently returning a *different*
resolution than the input (1254×1254 vs. a 1024×1024 input), which broke every
downstream pixel-coordinate assumption until the caller defensively resized the
result back to the exact input dimensions (still done regardless, as a backstop —
this size-matching just makes that resize a no-op in the common case).

### 7.6 Verification, per-field pinning, and targeted retries

`verifyPoster()` (`openai.client.ts`) replaced a flat `{qaScore, qaReasoning}`
shape with **8 independently-judged, pass/fail fields**: `headline`, `subtext`,
`cta`, `otherElements`, `photoAndLogo`, `noExtraDecoration`, `legibility`,
`alignment`. Each field's reasoning is written *before* its pass/fail verdict
(same "show your work before the answer" principle `scoreImage` itself uses — a
real, confirmed-live bug had a model's `qaScore` field committed to a number
*before* its own reasoning kept going and reversed the verdict entirely: a real
job's `qaReasoning` ended "Correction: This should NOT fail!... the correct score
should be 9" while the already-written `qaScore` stayed at 2, wrongly escalating a
poster that was actually fine).

Why per-field, not one blob: the earlier flat design meant a retry could only ever
throw away *all* the copy and forward the *entire* previous verdict paragraph as
feedback — and that paragraph often literally quoted the old (correct) headline as
confirmed-passing text, while the new attempt's freshly generated copy had a
genuinely different headline. The edit model, seeing both an old-headline mention
in the "feedback" and a new headline in the fresh copy, sometimes rendered the
*old* one.

Three functions in `run-deterministic-stage.ts` work together to fix this:

- **`mergeCopyWithPrevious`** — pins every copy field the previous attempt's
  verification already marked `pass: true` to its *exact* previous value; only a
  field that genuinely failed takes the freshly generated value. A passing field
  never gets a second chance to accidentally get worse, and there's never
  old-vs-new text for the same field sitting in the same prompt at once.
- **`buildRetryFeedback`** — builds a short "fix ONLY this" instruction from
  whichever specific fields actually failed, rather than forwarding the whole
  prior verdict.
- **`capScoreIfAnyFieldFailed`** — a real, confirmed-live gap: the generic
  orchestrator PASS/RETRY/ESCALATE decision only ever looks at the aggregate
  `qaScore`, so a design with exactly one genuinely-failed field (a wrong promo
  badge label, inconsistent alignment) could still cross the pass threshold on the
  strength of the other seven fields and reach human approval with a known defect.
  If **any** field failed, the effective score is deterministically capped at
  `QA_PASS_THRESHOLD - 1` regardless of whatever aggregate number the model itself
  proposed — one failed field can never hide behind a decent-looking average.

`PosterLayerBreakdown` (the extracted style + merged copy + per-field verification
for *this specific attempt*) is written to `StageAttempt.layerBreakdownJson` on
every attempt, pass or fail — this is what makes both the pinning logic above and
after-the-fact debugging of exactly what drove a given real attempt possible,
rather than having to guess.

Verification is attached **two** reference images: the campaign's real reference
(for overall style fidelity) and — critically — the **exact pre-edit composite**
(the real photo+logo *before* this text edit). A real, confirmed-live gap: without
that second image, the "photo/logo unaltered" hard-fail check had nothing to
actually compare against, and QA confidently stated the photo was unaltered while
the submitted output was visibly a different photo entirely.

### 7.7 No deterministic fallback

Unlike some hypothetical fallback path, a final failed poster attempt escalates to
`NEEDS_ATTENTION` exactly like every other stage in this pipeline — the code
comment states this explicitly as a deliberate choice: a visibly stuck job is
preferable to a silently-degraded one for something as customer-facing as the
finished creative.

---

## 8. The orchestrator engine

### 8.1 `StageDefinition` — the one contract every stage implements

(`orchestrator/types.ts`) Every registered stage provides: `name`, `queue`,
`buildPrompt(job, previousFeedback?)`, `getInputAssetUrl(job)`,
`nextStageOnPass` (a stage name, the literal `'AWAITING_APPROVAL'`, or `undefined`
for a terminal stage), an optional `isDeterministic` flag, and — for non-
deterministic stages only — an `execute(job, prompt, inputAssetUrl)` function that
owns calling the right provider(s) and returns a `StageResult`. The orchestrator
engine itself **never contains a stage name as a string literal** outside of
routing through this interface — adding a new stage means writing one of these,
never touching the engine.

### 8.2 `handleStageResult()` — the core decision routine

(`orchestrator/handle-stage-result.ts`) Called once per worker result, regardless
of which stage produced it. Wraps the read-decide-write cycle in a single Prisma
transaction scoped to the job's row — so two concurrent events for the same job
can never race each other into a lost update — but keeps the transaction **DB
writes only**. A real, confirmed-live bug found running an actual job end to end
(never caught by unit tests, which all use instant fake `execute()` results): the
deterministic-stage branch used to call `runDeterministicStage()` — real network
fetches, sharp compositing, a Cloudinary upload, and a *nested*
`handleStageResult()` call — synchronously from inside this transaction. That
routinely took 7–11+ seconds, blowing past Prisma's default 5-second interactive-
transaction timeout, and silently rolled back the current stage's own successful
DB write. Every slow side effect is now returned as a `PostCommitAction` thunk and
only executed **after** the transaction has actually committed.

Constants: `QA_PASS_THRESHOLD = 7` (loosened from an original 8, pipeline-wide,
deliberately), `MAX_CONTENT_RETRIES = 2` (loosened from 3) — both exported so
`run-deterministic-stage.ts`'s own retry loops for `logo_composite`/`poster` stay
in sync rather than duplicating the magic numbers.

Decision logic:
- `qaScore >= QA_PASS_THRESHOLD` → `advanceToNextStage()`
- else, `attemptNumber < MAX_CONTENT_RETRIES` → `retryWithFeedback()`
- else → `escalateToNeedsAttention()`

`advanceToNextStage()` handles several special cases: writing `baseAssetUrl`/
`posterUrl`/`baseLayerSpecJson` onto the Job row depending on which stage just
passed; the `nextStageOnPass === 'AWAITING_APPROVAL'` branch (flips status, emits
the approval-requested event); the dimension-stage branch (**must** be checked
before the generic "no next stage" early return, since dimension stages register
`nextStageOnPass: undefined` on purpose — an earlier planning doc's patch note
would have made this branch unreachable dead code, caught while writing it fresh
rather than by patching it in later per that note); and dispatching either a
queued job or an inline deterministic-stage run for whatever comes next.

`escalateTechnicalFailure()` is the separate path for when a stage's `execute()`
itself *throws* (network error, provider 401/5xx) rather than returning a
`StageResult` — handled after BullMQ's own technical retries (३× with exponential
backoff) are exhausted. Without this, a stage with a broken provider call (e.g. an
invalid API key) would fail three times inside BullMQ and then silently drop the
job with no DB or dashboard-visible error — the placeholder `StageAttempt` row
would stay `completedAt: null` forever, indistinguishable from a job still
legitimately in flight. Also handles a specific race condition gracefully: if a
manual "Retry" already deleted this stage's attempt rows before an old in-flight
attempt finishes failing on its own, the resulting "record not found" (Prisma
`P2025`) is logged and swallowed rather than treated as a real error — resurrecting
a superseded attempt row would be the actual bug.

### 8.3 Dispatch and idempotency

`dispatchStageJob()` (`queues/dispatch.ts`) first creates the placeholder
`StageAttempt` row (this is what makes the dashboard show "in progress" instead of
nothing while the real provider call is still running); if that create hits the
unique-constraint violation on `(jobId, stage, attemptNumber)`, the dispatch is
treated as an already-fired duplicate and silently no-ops rather than firing a
second paid API call. Only after the row is created does it actually `.add()` to
the right BullMQ queue, with `attempts: 3` (BullMQ's own **technical**-failure
retry count — entirely separate from and never counted against the orchestrator's
own content-quality retry budget) and exponential backoff.

### 8.4 Worker routing

`pipeline-worker.ts` defines the two BullMQ `Worker`s (`image-generation`,
`vision-scoring`) sharing one `processStageJob` processor. It looks up the
`StageDefinition`, throws loudly if it's accidentally handed a deterministic stage
(those should never reach a queue at all) or a stage with no `execute()`, runs it,
and hands the result to `handleStageResult()`. A `ScoringFailedError` thrown from
inside `execute()` (meaning generation already succeeded — real money spent, a
real image on Cloudinary — but only the scoring call failed) is caught specially:
`bullJob.discard()` stops BullMQ's normal retry (which would otherwise silently
re-run the whole paid generation step two more times for a scoring call that will
fail identically every time, since it's almost always a broken/misconfigured
provider key, not a transient blip), and `escalateTechnicalFailure` is called
immediately with the already-paid-for asset URL attached, rather than waiting for
all three BullMQ attempts to exhaust.

### 8.5 Stalled-job handling

(`queues/stalled-job-config.ts`) `lockDuration: 300_000` (5 minutes) — a real,
confirmed-live bug: the originally documented value was 30 seconds, but real
`base_asset`/`poster` generation calls routinely take 40–90s+ and were observed up
to 286 seconds in real logs. At 30s, BullMQ was reprocessing jobs that were still
legitimately running, producing genuine duplicate paid API calls plus a unique-
constraint failure on the second `StageAttempt` write. `maxStalledCount: 2` — after
two recoveries, a stalled job is treated as a permanent technical failure.

### 8.6 Manual retry (`retryStuckJob`)

A real, confirmed-live bug (found by actually clicking "Retry" in the dashboard on
a real escalated job): naively re-dispatching at `attemptNumber: 1` without first
deleting the stage's prior attempt rows is a silent no-op forever — a stage can
only reach `ESCALATED` after attempts 1..N already exist as rows, so the
idempotent-dispatch uniqueness guard always sees attempt 1 as "already dispatched"
and swallows the retry (status flips to `QUEUED`, nothing ever actually runs
again). The fix: `db.stageAttempt.deleteMany()` for that stage first, which is what
makes "reset the attempt count to 1" literally true rather than aspirational.
Also specifically branches for deterministic stages — a second real bug found
`dispatchStageJob()` always enqueuing onto a BullMQ queue even for
`logo_composite`/`poster`, which the worker unconditionally throws on ("should
never be queued"), silently escalating the job right back to `NEEDS_ATTENTION`
without ever actually re-running the stage. Applies the identical fix at the
dimension-job level too.

---

## 9. Provider clients

### 9.1 `gemini.client.ts` — image generation only

One function, `generateImage()`. Builds a Gemini `generateContent` request with
the prompt plus any labeled reference images (`file_data.file_uri`, never a bare
unlabeled image — a real defect once let a whole reference image get silently
ignored because it was mentioned only as dead text in the prompt string, never
actually attached; every reference image anywhere in this codebase is now
attached with an explicit role label immediately preceding it). Cost is computed
locally from a hardcoded per-model pricing snapshot (`MODEL_COST_INR`), not queried
from the provider's billing API synchronously per call.

**Currently in progress (uncommitted, see §12.2):** a real, confirmed-live timeout
bug and its fix. Axios's own `timeout` option (the shared client's 60s default)
does **not** reliably abort a call under Bun's HTTP adapter — the same failure mode
already found once before for OpenAI's `editPosterImage()`. Three separate real
`base_asset` generations were observed hanging forever with no resolve/reject and,
confirmed via `lsof`, **zero open OS-level socket** to Gemini — the network
exchange had already finished, only the JS-level promise never settled. The fix
adds an `AbortController` as a second, independent enforcement mechanism (belt-
and-suspenders alongside the axios `timeout` — whichever fires first doesn't
matter, only that one reliably does), set to 300 seconds to match the already-
vetted `stalledJobWorkerOptions.lockDuration` figure. A `timeoutMs` override param
exists purely so tests can simulate a hang without a real 300-second wait;
production code never sets it.

### 9.2 `openai.client.ts` — everything else AI (~1150 lines)

This is the largest file in the codebase and does essentially all of the "vision
judgment" and "text/copy generation" work. Every call goes through one of two
internal helpers, `callChatModel`/`callVisionModel`, both hitting
`/chat/completions` with `response_format: { type: 'json_object' }`. A
`temperature` param is optional and, when passed low (0.2), is used specifically
for "observe and describe what's actually there" calls (style extraction, base-
layer classification) — a real, confirmed-live defect found the *same* reference
image, re-extracted fresh on two different submissions, coming back with
meaningfully different structural reads (a gradient headline one time, flat color
the next) at the API's default sampling temperature; low temperature is
specifically for run-to-run consistency on observational tasks, not creative ones
like ad-copy writing (which uses the default).

Public functions, in the order a job actually calls them:
1. `classifyBaseLayer` — §6.1
2. `analyzeReferenceStyle` — §7.1/7.2
3. `generateAdCopy` — §7.3
4. `detectLogoPosition` — §6.3
5. `scoreImage` — the generic single-field QA judge used by `base_asset`,
   `logo_composite`, and the dimension stages
6. `verifyPoster` — the poster-specific 8-field judge, §7.6
7. `editPosterImage` — the real `/v1/images/edits` multipart call

`editPosterImage()` is the one function in this file that isn't a `/chat/completions`
call — it's a real masked (now optional-mask) inpaint call against
`/v1/images/edits`, built as `multipart/form-data` via Bun/Node's native
`FormData`/`Blob` (no official OpenAI SDK is installed in this repo — every
provider call anywhere in the codebase is raw HTTP via the shared axios instance,
by deliberate consistency). The code comments record that both the masked
single-image behavior and the multi-image (`image[]`) reference-crop behavior were
each **confirmed live via a real paid spike call** before any production code
depended on them — e.g. a solid-color base image with a real alpha mask (top half
transparent, bottom half opaque) returned an edit landing only in the transparent
region, confirming OpenAI's documented mask semantics (alpha 0 = editable, alpha
255 = preserved) firsthand rather than trusting documentation alone. Carries its
own `AbortController`-based 120-second timeout for the same axios-doesn't-reliably-
abort-under-Bun reason as the Gemini client (§9.1), just with a shorter window
since single edit calls, unlike base image generation, don't legitimately run past
that.

`PosterStyleSpec`, `BaseLayerSpec`, `AdCopy`, `ColorSpec`, `ReferenceBox`,
`VisualReferenceHint`, `HeadlineLineStyle`, `PosterVerificationFields` are all
defined in this file as the shared vocabulary every other orchestrator file
imports — this is effectively the type contract layer for the whole poster
pipeline, in addition to being the provider client.

### 9.3 `cloudinary.client.ts`

Uploads via a base64 data URI, **not** `upload_stream()` — a real, confirmed-by-
reproduction defect found `upload_stream()` under Bun silently mishandling the
signed multipart request once a buffer crosses roughly 2MB (Cloudinary's generic
"Upload preset must be specified" error, even with correctly configured
credentials). Buffers under 2MB streamed fine, but every real pipeline asset
(photos, posters) routinely exceeds that — this wasn't treated as an edge case to
special-case around; the whole function moved off the streaming path entirely.

`extractPublicId()` recovers a Cloudinary `public_id` by parsing it back out of one
of this app's own secure URLs (nothing in the DB stores `public_id` directly, only
the URL) — returns `null` (never throws) for anything that doesn't match the
expected shape, since asset cleanup during job deletion is explicitly best-effort,
not a hard requirement for the delete itself to succeed.

---

## 10. REST API surface (`jobs.routes.ts`, mounted at `/api/v1/jobs`)

| Method & path | Purpose |
|---|---|
| `POST /` | Create a job. `multipart/form-data`: `reference1`, `reference2`, `logo` files + a `prompt` text field. Validates file type/size deterministically (`assertFile`) before any AI call. Uploads all three files to Cloudinary, creates the `Job` row at `BASE_LAYER_CLASSIFYING`, emits `feed:job_created`, and dispatches the first stage. |
| `GET /` | List jobs — `status` filter (any real `JobStatus` value), `limit`/`offset` pagination. Filters `deletedAt: null`. Returns `prompt` directly on each summary row (fixed a real N+1 — the dashboard used to fetch every visible job's full detail just to render a list preview). |
| `GET /:id` | Full job detail — includes `stageAttempts`, `dimensionJobs`, `approvalLog`. |
| `POST /:id/approve` | REST fallback for the socket-based approval flow. |
| `POST /:id/reject` | Same, for rejection. |
| `POST /:id/retry` | Manual retry from `NEEDS_ATTENTION` — see §8.6. |
| `PATCH /:id` | Rename (`name` field, 1–140 chars). |
| `DELETE /:id` | Soft-delete the Job row + hard-delete every Cloudinary asset it owns — §11.1 style irreversibility, see `delete-job.ts`. |

Every response is shaped by the shared `{data: ...}` / `{error: {code, message,
details}}` envelope (`envelope.schema.ts`) — never ad hoc. `ApiError` is the only
error type route handlers should ever throw; `error-handler.ts` is the one place
it becomes an HTTP response, registered last in the Express middleware chain.

`deleteJob()` (`orchestrator/delete-job.ts`) is worth calling out specifically:
it soft-deletes the `Job` row (reversible, keeps cost/audit history intact) but
**hard-deletes** every real Cloudinary asset the job ever produced or was given —
both references, the logo, every `StageAttempt`'s asset (including failed/retried
attempts, not just whichever ended up linked to the Job row), and every dimension
asset. This is the one genuinely irreversible part of "delete" in this system —
once a Cloudinary asset is destroyed it cannot be recovered. Cleanup is
best-effort per-URL (`Promise.allSettled`) so one bad or already-gone URL never
blocks the rest of the cleanup or leaves the job itself stuck undeletable.

---

## 11. Realtime layer (Socket.IO)

Two rooms per socket connection: a per-job room (`job:${jobId}`, joined via
`join:job`) and one bounded global room (`join:global`) for the dashboard's job
feed/sidebar.

Server→client events (`emitters.ts` — the **only** module in the codebase allowed
to emit through the socket instance directly, a deliberately enforced single
choke point):

| Event | Rooms | Purpose |
|---|---|---|
| `job:status_changed` | job room only | Every status transition |
| `job:approval_requested` | job room | Poster ready for human review |
| `job:needs_attention` | job room + global | Escalation — reaches global since it changes the Needs Attention queue view |
| `job:completed` | job room + global | All dimensions terminal |
| `feed:job_created` | global only | New job submitted |
| `feed:job_deleted` | job room + global | A second tab with that job open needs to know it's gone too |

Client→server: `join:job`, `join:global`, `job:approval_response` (the actual
approve/reject action, handled by `approval-handler.ts`'s `approveJob`/`rejectJob`
— identical logic to the REST fallback endpoints).

A real, confirmed-live gap (found by actually watching a job escalate in a real
browser): `escalateToNeedsAttention` used to only emit `job:needs_attention`
(global + per-job room) and never `job:status_changed` — so the Needs Attention
queue correctly showed the job, but anyone with that job's own detail view open
(which only listens for `status_changed`) never saw its badge move past whatever
stage it was stuck on. Both events are now emitted together on escalation.

---

## 12. What's currently uncommitted in the working tree

Everything below is real, working code sitting in the git working directory right
now (per `git status`/`git diff` at the time this doc was written) — not yet
committed. It's already woven into the relevant sections above; this is the
consolidated summary of exactly what changed and why, all from confirmed real
defects found while iterating live on real jobs:

### 12.1 Background pattern support (the largest change)
A reference poster's giant repeated/tiled background word (e.g. a brand word
tiled diagonally behind the subject) previously had **nowhere to live** in the
extracted schema at all and was silently dropped — the single most visually
distinctive design device in some references never reached the generated output.
Fixed end-to-end: a new `backgroundPattern` field on `PosterStyleSpec`
(`openai.client.ts`), a new extraction prompt section in `analyzeReferenceStyle`,
a new clamp block in `render-poster.ts`'s `clampStyle`, a new prompt block in
`poster-text-edit.ts`'s `styleInstructionsBlock` (rendered first, as a background
layer, with explicit instructions to paint over any garbled/blank attempt left by
`base_asset` rather than preserve it), and a corresponding correction to
`base_asset`'s own prompt telling it to paint the container/panel this pattern
belongs on but leave it deliberately **unlettered** (a text-generation model
repeating a word many times in one image reliably produces drifting, malformed
letterforms — the real legible wordmark is deferred entirely to the poster stage).
`backgroundTreatment`'s own extraction instruction was also corrected: a non-text
container a wordmark happens to sit on (a color block, a diagonal panel) must
still be described there — only the literal lettering is excluded, not the whole
element. All affected test fixtures (`render-poster.test.ts`,
`run-deterministic-stage.test.ts`) were updated with the new field.

### 12.2 Gemini call timeout hardening
See §9.1 — an `AbortController` added as a second, independent 300-second timeout
enforcement alongside axios's own (unreliable-under-Bun) `timeout` option, matching
`stalledJobWorkerOptions.lockDuration`'s already-vetted figure. New
`gemini.client.test.ts` (73 lines) added to actually verify the abort wiring fires,
using the same "override `.defaults.adapter` to simulate a hang" technique
`http-client.test.ts` already used for 429/5xx simulation — this is also why the
`gemini` axios instance itself became an exported (not module-private) binding.

### 12.3 Dash-stripping compound-word fix
See §7.3 — `stripDashesCore` now distinguishes a tight (no-whitespace) dash from a
spaced one and replaces them differently, fixing a real broken-compound-word defect
confirmed on a real paid run ("mom-to-be" → "mom, to, be").

### 12.4 Base-asset rubric now checks the campaign brief
See §6.2 — `buildBaseAssetRubric` takes a new `campaignBrief` param and runs a
concrete-content checklist pass, closing a real defect where a generated photo
silently dropped a brief-specified subject/prop and still scored 9/PASS.

### 12.5 New test fixtures
Four new sample campaigns under `test/level-10/`, `test/work-01/`, `test/work-02/`,
`test/work-03/` (each: `logo.png` + two reference images + `prompt.txt`).
`test/level-1/prompt.txt` was rewritten from a generic neck/shoulder-pain brief to
a specific prenatal/pregnancy campaign for "Half Marathon" (Times Internet) — most
likely the real brief actually being used to exercise the background-pattern work
above, since a real client campaign is a more realistic source of that design
pattern than a synthetic test brief would be.

### 12.6 `main.excalidraw`
A new, large (~14MB) local diagram file at the repo root — not part of the app
source, likely working notes or an architecture sketch. Unrelated to runtime code.

---

## 13. Known, deliberate drift from any older planning docs

(Still true as of this read — carried over from prior verified project context,
independently re-confirmed against current source in this session.)

- `QA_PASS_THRESHOLD = 7` / `MAX_CONTENT_RETRIES = 2` — loosened pipeline-wide from
  an original 8/3, deliberately (`handle-stage-result.ts`).
- `getOrExtractStyle()` is genuinely **not cached** in the sense its name might
  imply beyond the specific 3-tier logic in §7.2 — caching was deliberately kept
  narrow while this design is still being iterated on.
- `stalledJobWorkerOptions.lockDuration = 300_000` (5 minutes), not the 30 seconds
  an original LLD specified — real generation calls have been observed taking up
  to 286 seconds.
- The real `.env` (not `.env.example`, which is clean) has previously been noted
  to carry a fully-configured but **entirely dead** Cloudflare R2 block with zero
  code references anywhere — all storage goes through `cloudinary.client.ts`
  exclusively. Not independently re-verified in this session (the real `.env`
  contains live secrets and wasn't read), but nothing in the current source tree
  references R2/S3-style storage anywhere.

---

## 14. Where to look first in a future session

`readme.md` at the repo root (582 lines) is the canonical, prose-form doc the user
had generated from a full source read and asked to be kept refreshed from code
whenever it drifts — that should be the very first stop for a fresh orientation,
with this file as a much deeper supplementary reference. The user's explicit,
standing policy for this repo: **the code is the true progress record, not any
doc** — trust `git log`/the actual source over any doc's claims, including this
one, if they ever disagree.

If going straight to code for the parts that change most often, in rough order of
how frequently they've been touched historically: `apps/api/src/orchestrator/
poster-text-edit.ts` and `run-deterministic-stage.ts` (the poster stage's real
prompt/verification/retry logic), `apps/api/src/providers/openai.client.ts` (every
AI text/vision call plus the image-edit call), `apps/api/src/orchestrator/
render-poster.ts` (style extraction + clamping/caching), `apps/api/src/stages/
base-asset.stage.ts` (base photo prompt + rubric). This codebase has changed
materially every few days throughout August 2026 — always verify a specific claim
against current source before depending on it, especially anything with a file:line
reference more than a session or two old.
