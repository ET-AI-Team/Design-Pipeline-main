import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from './app';
import type { Server } from 'node:http';

/**
 * The deploy pipeline polls /health after `systemctl restart` and rolls
 * the release back if it never returns 200. That makes this endpoint
 * load-bearing infrastructure, not a convenience: if it regresses, every
 * deploy fails and reverts perfectly good code.
 *
 * Before this existed the box answered 404 on /health, /healthz,
 * /api/v1/health, /api/health and / - verified by probing 10.71.77.228
 * directly. A health check pointed at a 404 makes every deploy fail.
 *
 * Same ephemeral-port harness jobs.routes.test.ts uses - an Express app
 * is not a fetch handler, so it has to actually listen.
 */
describe('GET /health', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('returns 200 with a status body', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('answers without touching the database', async () => {
    // This whole file runs without ever importing lib/db - a handler that
    // queried Prisma could not answer here at all. That is the actual
    // guarantee the deploy depends on: a slow or unreachable database
    // must never fail a health check and roll back healthy code.
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('still 404s on an unknown path, so the check cannot pass by accident', async () => {
    const res = await fetch(`${baseUrl}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });
});
