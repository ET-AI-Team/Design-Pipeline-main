# API Contracts — Design Pipeline

Generated from a direct read of the live source (`apps/api/src/routes/jobs.routes.ts`,
`apps/api/src/realtime/*`, `packages/shared-types/src/*`, `apps/api/prisma/schema.prisma`)
on 2026-08-31. This is the actual current contract, not a spec — if it ever disagrees
with the code, trust the code and regenerate this file.

Base URL: `http://localhost:8080` (port from `.env`'s `PORT`)
Base path for every REST route below: **`/api/v1/jobs`**
No auth, no multi-tenancy — internal-only tool.

---

## 1. Response envelope (every REST response)

All success responses:
```json
{ "data": { ... } }
```

All error responses:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "human-readable message",
    "details": { "field": "..." }   // optional, present on some errors
  }
}
```

`code` is one of:
| Code | Typical HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod schema validation failed, or a required file field is missing |
| `UNSUPPORTED_FILE_TYPE` | 415 | Uploaded file's mimetype isn't in the accepted list |
| `FILE_TOO_LARGE` | 413 | Uploaded file exceeds its size cap |
| `JOB_NOT_FOUND` | 404 | No job with that id (or it's soft-deleted) |
| `INVALID_STATE_TRANSITION` | — | Reserved in the enum; not currently thrown anywhere in the read source |
| `INTERNAL_ERROR` | 500 | Anything unhandled — logged server-side via Pino, generic message returned to the client |

Source: `packages/shared-types/src/schemas/envelope.schema.ts`, `apps/api/src/middleware/error-handler.ts`, `apps/api/src/lib/api-error.ts`.

---

## 2. Endpoints

### 2.1 `POST /api/v1/jobs` — create a job

`multipart/form-data`.

**Fields:**
| Field | Type | Constraint |
|---|---|---|
| `reference1` | file | required; mime ∈ `image/jpeg`, `image/png`, `image/webp`; ≤ 15 MB |
| `reference2` | file | same as above |
| `logo` | file | required; mime ∈ `image/png`, `image/svg+xml`; ≤ 5 MB |
| `prompt` | text | required string, 10–2000 chars |

Files are validated (type/size) via `assertFile()` **before** any AI call or upload. `prompt` is validated by `CreateJobSchema` (Zod).

**What happens server-side:** all three files upload to Cloudinary in parallel → a `Job` row is created with `status: "BASE_LAYER_CLASSIFYING"` → `feed:job_created` is emitted globally → the `base_layer_classification` stage is dispatched (fired, not awaited to completion) before the response is sent.

**Success — `201`:**
```json
{
  "data": {
    "jobId": "uuid",
    "status": "BASE_LAYER_CLASSIFYING",
    "createdAt": "2026-08-31T12:00:00.000Z"
  }
}
```

**Errors:** `VALIDATION_ERROR` (400, missing/invalid `prompt` or missing file field), `UNSUPPORTED_FILE_TYPE` (415), `FILE_TOO_LARGE` (413).

---

### 2.2 `GET /api/v1/jobs` — list jobs

**Query params** (`ListJobsQuerySchema`):
| Param | Type | Default | Constraint |
|---|---|---|---|
| `status` | string | — | optional; must be one of the 13 `JobStatus` values (§4) |
| `limit` | number | `20` | 1–100 |
| `offset` | number | `0` | ≥ 0 |

Only jobs with `deletedAt: null` are returned, ordered by `createdAt desc`.

**Success — `200`:**
```json
{
  "data": {
    "jobs": [
      {
        "jobId": "uuid",
        "name": "My Campaign",
        "status": "AWAITING_APPROVAL",
        "prompt": "1:1 square health ad for...",
        "createdAt": "2026-08-31T12:00:00.000Z",
        "updatedAt": "2026-08-31T12:05:00.000Z"
      }
    ],
    "total": 42,
    "limit": 20,
    "offset": 0
  }
}
```
`prompt` is returned directly on each summary row (fixes an earlier N+1 where the dashboard had to fetch full job detail just to render a list preview).

---

### 2.3 `GET /api/v1/jobs/:id` — full job detail

**Success — `200`:**
```json
{
  "data": {
    "id": "uuid",
    "name": "My Campaign",
    "status": "AWAITING_APPROVAL",
    "reference1Url": "https://res.cloudinary.com/.../references/...",
    "reference2Url": "https://res.cloudinary.com/.../references/...",
    "logoUrl": "https://res.cloudinary.com/.../logos/...",
    "prompt": "...",
    "baseAssetUrl": "https://res.cloudinary.com/...",
    "posterUrl": "https://res.cloudinary.com/...",
    "styleSpecJson": { "...": "PosterStyleSpec, see §6" },
    "baseLayerSpecJson": { "...": "BaseLayerSpec, see §6" },
    "createdAt": "2026-08-31T12:00:00.000Z",
    "updatedAt": "2026-08-31T12:05:00.000Z",
    "deletedAt": null,

    "stageAttempts": [
      {
        "id": "uuid",
        "jobId": "uuid",
        "stage": "poster",
        "attemptNumber": 1,
        "modelUsed": "gpt-image-2",
        "latencyMs": 24310,
        "costInr": "3.42",
        "qaScore": "8",
        "boundingBoxJson": null,
        "layerBreakdownJson": { "...": "PosterLayerBreakdown, only on stage=poster" },
        "assetUrl": "https://res.cloudinary.com/...",
        "qaReasoning": "...",
        "result": "PASS",
        "startedAt": "2026-08-31T12:01:00.000Z",
        "completedAt": "2026-08-31T12:01:24.000Z"
      }
    ],
    "dimensionJobs": [
      { "id": "uuid", "jobId": "uuid", "dimension": "9x16", "status": "DELIVERED", "assetUrl": "https://..." },
      { "id": "uuid", "jobId": "uuid", "dimension": "4x5", "status": "GENERATING", "assetUrl": null },
      { "id": "uuid", "jobId": "uuid", "dimension": "1.91x1", "status": "PENDING", "assetUrl": null }
    ],
    "approvalLog": {
      "id": "uuid",
      "jobId": "uuid",
      "decision": "approve",
      "comment": null,
      "decidedAt": "2026-08-31T12:06:00.000Z"
    }
  }
}
```
Notes:
- `boundingBoxJson` is only ever populated when `stage === "logo_composite"` (the placed `{x, y, width, height}` box).
- `layerBreakdownJson` is only ever populated when `stage === "poster"`.
- `approvalLog` is `null` until a decision has been made (at most one per job).
- `completedAt: null` on a `StageAttempt` means it's still in flight (the dashboard uses this to distinguish "in progress" from a stale-looking `RETRY`).

**Errors:** `JOB_NOT_FOUND` (404) if the id doesn't exist or is soft-deleted.

---

### 2.4 `POST /api/v1/jobs/:id/approve` — approve the poster

Calls the same `approveJob()` logic the Socket.IO `job:approval_response` event uses — a REST fallback for the same action. Records an `ApprovalLog` row, flips status to `DIMENSION_EXPANDING`, creates all 3 `DimensionJob` rows, dispatches all 3 dimension stage attempts in parallel.

**Success — `200`:**
```json
{ "data": { "jobId": "uuid", "status": "DIMENSION_EXPANDING" } }
```

### 2.5 `POST /api/v1/jobs/:id/reject` — reject the poster

**Body** (optional): none required by the route itself (comment is passed via the socket path's payload shape; the REST fallback here doesn't currently accept a body field — check `rejectJob()` if you need to pass a comment via REST).

Records `ApprovalLog`, flips status to `REJECTED`. Terminal — no automatic retry path. Recovery is the dashboard's "regenerate with changes" flow, which starts a **new** job.

**Success — `200`:**
```json
{ "data": { "jobId": "uuid", "status": "REJECTED" } }
```

### 2.6 `POST /api/v1/jobs/:id/retry` — manual retry from `NEEDS_ATTENTION`

Deletes the stuck stage's prior `StageAttempt` rows (so the idempotent-dispatch uniqueness guard doesn't silently swallow the retry as "already dispatched"), then re-dispatches at attempt 1. Branches for deterministic stages (`logo_composite`, `poster`) vs queued ones, and for dimension-job-level stuck states.

**Success — `200`:**
```json
{ "data": { "jobId": "uuid", "status": "BASE_ASSET_GENERATING" } }
```
(`status` reflects whichever stage was retried.)

### 2.7 `PATCH /api/v1/jobs/:id` — rename a job

**Body:**
```json
{ "name": "New display name" }
```
`name`: trimmed string, 1–140 chars (`RenameJobSchema`).

**Success — `200`:**
```json
{ "data": { "jobId": "uuid", "name": "New display name" } }
```
**Errors:** `VALIDATION_ERROR` (400), `JOB_NOT_FOUND` (404).

### 2.8 `DELETE /api/v1/jobs/:id` — delete a job

Soft-deletes the `Job` row (`deletedAt` set — reversible, keeps cost/audit history) but **hard-deletes** every Cloudinary asset the job ever produced or was given (both references, the logo, every stage attempt's asset including failed/retried ones, every dimension asset). Cleanup is best-effort per-URL (`Promise.allSettled`) — one bad/already-gone URL never blocks the rest or leaves the job stuck undeletable. This is the one genuinely irreversible part of "delete."

**Success — `204 No Content`** (empty body).

---

## 3. Socket.IO contract

Same server, attached to the HTTP server. No separate port. CORS origin `*`.

### 3.1 Rooms
- `job:${jobId}` — joined via `join:job`; per-job updates.
- `global` — joined via `join:global`; the dashboard's sidebar/feed room.

### 3.2 Client → Server events

| Event | Payload | Effect |
|---|---|---|
| `join:job` | `{ jobId: string }` | joins the socket to that job's room |
| `join:global` | *(none)* | joins the socket to the global room |
| `job:approval_response` | `{ jobId: string, decision: "approve" \| "reject", comment?: string }` | calls `approveJob()`/`rejectJob()` — identical logic to the REST fallback endpoints; errors are logged server-side, not surfaced back over the socket |

### 3.3 Server → Client events

| Event | Payload | Rooms |
|---|---|---|
| `job:status_changed` | `{ jobId, status: JobStatus, timestamp: ISO8601 }` | job room only |
| `job:approval_requested` | `{ jobId, posterUrl }` | job room only |
| `job:needs_attention` | `{ jobId, stage: string, qaReasoning: string }` | job room **+ global** |
| `job:completed` | `{ jobId, dimensions: Array<{ dimension: string, assetUrl: string }> }` | job room **+ global** |
| `feed:job_created` | `{ jobId, createdAt: ISO8601 }` | global only |
| `feed:job_deleted` | `{ jobId }` | job room **+ global** |

`emitters.ts` is the **only** module allowed to call `io.emit`/`io.to().emit` directly — every server→client push in the whole codebase goes through one of the six functions above (`emitStatusChanged`, `emitApprovalRequested`, `emitNeedsAttention`, `emitJobCompleted`, `emitJobCreated`, `emitJobDeleted`).

Source: `packages/shared-types/src/socket-events.ts`, `apps/api/src/realtime/socket-server.ts`, `apps/api/src/realtime/emitters.ts`.

---

## 4. `JobStatus` enum (13 values — the full state machine)

```
QUEUED
  → BASE_LAYER_CLASSIFYING
  → BASE_ASSET_GENERATING → BASE_ASSET_SCORING
  → LOGO_PLACEMENT_DETECTING → LOGO_COMPOSITING
  → POSTER_GENERATING → POSTER_SCORING
  → AWAITING_APPROVAL  ── human checkpoint ──┐
                                              ↓
                                  DIMENSION_EXPANDING
                                              ↓
                                          COMPLETE

Any active stage can instead terminate into:
  NEEDS_ATTENTION   (a stage exhausted its content-quality retries)
  REJECTED          (human rejected at the approval checkpoint)
```

`DimensionJob.status` (separate, per-dimension): `PENDING → GENERATING → SCORING → DELIVERED | NEEDS_ATTENTION`.

`StageAttempt.result`: `PASS | RETRY | ESCALATED`.

Source: `packages/shared-types/src/enums.ts` (single source of truth, mirrored verbatim by `apps/api/prisma/schema.prisma`).

---

## 5. Dimension names

`DIMENSION_NAMES = ["9x16", "4x5", "1.91x1"]` — the exact three strings used as `DimensionJob.dimension` values and dimension-stage names (`dimension_9x16`, `dimension_4x5`, `dimension_1.91x1`). Defined once in `packages/shared-types/src/enums.ts`, reused everywhere.

---

## 6. Notable JSON blob shapes referenced above

These aren't separate endpoints, but they're what `styleSpecJson`, `baseLayerSpecJson`, and `layerBreakdownJson` actually contain — worth knowing since the dashboard and any API consumer will parse them:

- **`BaseLayerSpec`** (`baseLayerSpecJson`) — `{ compositionGuide, backgroundTreatment, photoStyle: { colorGrading, lighting, setting, framing }, notes }`. All freeform prose strings, no fixed categories.
- **`PosterStyleSpec`** (`styleSpecJson`) — the large extracted design contract: margins/spacing ratios, per-line headline styles, subtext/cta/trustList specs, `backgroundPattern`, `otherElements[]`, `elementOrder[]`, `textColumnWidthRatio`, `centerXRatio`, etc. Defined in `apps/api/src/providers/openai.client.ts`.
- **`PosterLayerBreakdown`** (`layerBreakdownJson`, poster stage only) — the extracted style + merged ad copy + per-field verification (`headline`, `subtext`, `cta`, `otherElements`, `photoAndLogo`, `noExtraDecoration`, `legibility`, `alignment`) for that specific attempt.

These are intentionally not re-typed here in full — they're large and change often (see `info.md` §7 for the current field-by-field breakdown); treat `openai.client.ts` as the source of truth for their exact shape.

---

## 7. File upload constraints (quick reference)

| | `reference1` / `reference2` | `logo` |
|---|---|---|
| Accepted mime types | `image/jpeg`, `image/png`, `image/webp` | `image/png`, `image/svg+xml` |
| Max size | 15 MB | 5 MB |

Constants: `ACCEPTED_IMAGE_MIME_TYPES`, `ACCEPTED_LOGO_MIME_TYPES`, `MAX_REFERENCE_FILE_BYTES`, `MAX_LOGO_FILE_BYTES` — `packages/shared-types/src/schemas/job.schema.ts`.
