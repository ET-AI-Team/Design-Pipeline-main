import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:http';
import { io as ioClient, type Socket } from 'socket.io-client';
import { attachSocketServer, getSocketServer, GLOBAL_ROOM } from './socket-server';

/**
 * Polls instead of a single fixed sleep. A blind setTimeout(150ms) was
 * flaky when this suite ran alongside other files doing real DB/Redis
 * I/O in the same process - event-loop contention from unrelated work
 * sometimes pushed local Socket.IO delivery past 150ms even though it's
 * normally sub-10ms. Polling gives a much bigger ceiling without slowing
 * down the common case.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('socket room scoping (LLD §6.1)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let jobRoomClient: Socket;
  let globalOnlyClient: Socket;

  beforeAll(async () => {
    httpServer = createServer();
    attachSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    port = typeof address === 'object' && address ? address.port : 0;

    // forceNew: true - socket.io-client caches/reuses one Manager per
    // identical URL by default, so two clients to the same URL in the
    // same process can race and the second never fires 'connect'.
    // Confirmed by reproducing the hang directly before this fix. Even
    // with forceNew, creating both clients simultaneously and awaiting
    // them in parallel was still occasionally racy under load (the
    // second connect never fired) - connecting fully sequentially
    // instead removes that race entirely.
    jobRoomClient = ioClient(`http://localhost:${port}`, { forceNew: true });
    await new Promise<void>((resolve) => jobRoomClient.on('connect', () => resolve()));

    globalOnlyClient = ioClient(`http://localhost:${port}`, { forceNew: true });
    await new Promise<void>((resolve) => globalOnlyClient.on('connect', () => resolve()));

    jobRoomClient.emit('join:job', { jobId: 'test-job-1' });
    globalOnlyClient.emit('join:global');
    await new Promise((resolve) => setTimeout(resolve, 300)); // let room joins settle
  }, 15_000);

  afterAll(() => {
    jobRoomClient.close();
    globalOnlyClient.close();
    httpServer.close();
  });

  it('job:status_changed reaches only the per-job room, not the global room', async () => {
    let jobRoomReceived = false;
    let globalReceived = false;

    jobRoomClient.on('job:status_changed', () => { jobRoomReceived = true; });
    globalOnlyClient.on('job:status_changed', () => { globalReceived = true; });

    getSocketServer().to('job:test-job-1').emit('job:status_changed', {
      jobId: 'test-job-1',
      status: 'POSTER_GENERATING',
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => jobRoomReceived);
    // A bit more grace before asserting the negative, so a merely-slow
    // (not actually bounded) global delivery can't produce a false pass.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(jobRoomReceived).toBe(true);
    expect(globalReceived).toBe(false); // the bounding fix from LLD §6.1
  }, 10_000);
});
