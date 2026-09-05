import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../app';
import { db } from '../lib/db';
import type { Server } from 'node:http';

describe('jobs routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    server.close();
  });

  it('GET /api/v1/jobs/:id returns 404 for a non-existent job', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('JOB_NOT_FOUND');
  });

  it(
    'POST /api/v1/jobs/:id/retry returns 409 when the job is not NEEDS_ATTENTION',
    async () => {
      const job = await db.job.create({
        data: {
          reference1Url: 'https://example.com/r1.png',
          reference2Url: 'https://example.com/r2.png',
          logoUrl: 'https://example.com/logo.png',
          prompt: 'a job not in needs attention, ten-plus chars',
          status: 'POSTER_GENERATING',
        },
      });

      const res = await fetch(`${baseUrl}/api/v1/jobs/${job.id}/retry`, { method: 'POST' });
      expect(res.status).toBe(409);

      await db.job.delete({ where: { id: job.id } });
    },
    15_000
  );

  it('POST /api/v1/jobs rejects a submission missing required files', async () => {
    const form = new FormData();
    form.append('prompt', 'a prompt with no files attached at all here');

    const res = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // --- the logo is optional, but still validated when present ---
  //
  // There is deliberately NO "posts without a logo and expects 201" test.
  // Reaching 201 creates a real Job row and fires finalizeJobCreation,
  // which performs real Cloudinary uploads and dispatches the pipeline -
  // roughly Rs 66 of real generation per run. The optional-ness is
  // covered by the two boundary tests below plus the skip-path unit test,
  // and end-to-end by a manual run against the live stack.
  //
  // Note assertFile/assertOptionalFile here check the DECLARED mimetype
  // and size only - no content sniffing - so these fixtures need no real
  // image bytes.
  function blob(type: string): Blob {
    return new Blob([new Uint8Array([1, 2, 3, 4])], { type });
  }

  it('POST /api/v1/jobs still rejects a logo of the wrong type - optional does not mean unvalidated', async () => {
    const form = new FormData();
    form.append('prompt', 'a prompt long enough to satisfy the schema here');
    form.append('reference1', blob('image/png'), 'r1.png');
    form.append('reference2', blob('image/png'), 'r2.png');
    // JPEG is fine for a reference and wrong for a logo (PNG/SVG only).
    form.append('logo', blob('image/jpeg'), 'logo.jpg');

    const res = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', body: form });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(body.error.details.field).toBe('logo');
  });

  it('POST /api/v1/jobs keeps BOTH references mandatory - only the logo became optional', async () => {
    // The guard against loosening the wrong field. reference2 in
    // particular is load-bearing: it is the sole input to style
    // extraction and base-layer classification.
    const form = new FormData();
    form.append('prompt', 'a prompt long enough to satisfy the schema here');
    form.append('reference1', blob('image/png'), 'r1.png');
    // reference2 and logo both absent - it must complain about reference2.
    const res = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('reference2');
  });

  it('GET /api/v1/jobs applies default pagination', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.limit).toBe(20);
    expect(body.data.offset).toBe(0);
    expect(Array.isArray(body.data.jobs)).toBe(true);
  });

  it('GET /api/v1/jobs includes prompt on each summary - the dashboard\'s job list renders a preview from this rather than fetching every job\'s detail individually', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs?limit=1`);
    const body = await res.json();
    if (body.data.jobs.length > 0) {
      expect(typeof body.data.jobs[0].prompt).toBe('string');
    }
  });
});
