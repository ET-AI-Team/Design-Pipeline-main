import { describe, it, expect } from 'bun:test';
import { db } from './db';

describe('db singleton', () => {
  it(
    'connects and can round-trip a soft-deleted Job row',
    async () => {
      const job = await db.job.create({
        data: {
          reference1Url: 'https://example.com/ref1.png',
          reference2Url: 'https://example.com/ref2.png',
          logoUrl: 'https://example.com/logo.png',
          prompt: 'a test job for db connectivity',
        },
      });

      expect(job.status).toBe('QUEUED');
      expect(job.deletedAt).toBeNull();

      const softDeleted = await db.job.update({
        where: { id: job.id },
        data: { deletedAt: new Date() },
      });
      expect(softDeleted.deletedAt).not.toBeNull();

      // Cleanup: hard delete the test row so the test suite is idempotent.
      await db.job.delete({ where: { id: job.id } });
    },
    // Three sequential round trips to a remote Supabase pooler measured at
    // 800ms-2s each from this network - the 5000ms default is too tight.
    15_000
  );

  // Deliberately no afterAll disconnect here - `db` is a process-wide
  // singleton every other test file also uses. Bun runs all matched
  // files in one process, so disconnecting it per-file risks the same
  // cross-file poisoning found with dispatch.test.ts's queue teardown.
});
