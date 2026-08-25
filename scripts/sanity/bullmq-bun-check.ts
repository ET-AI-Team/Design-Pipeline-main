/**
 * Disposable sanity check - not part of the application.
 * Confirms BullMQ + ioredis + Bun correctly handle:
 *   1. basic enqueue/process
 *   2. automatic retry with backoff on a simulated failure
 * Run with: bun run scripts/sanity/bullmq-bun-check.ts
 */
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const QUEUE_NAME = 'sanity-check-queue';
const queue = new Queue(QUEUE_NAME, { connection });

let attemptCount = 0;

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    attemptCount += 1;
    console.log(`[worker] attempt ${attemptCount} for job ${job.id}`);

    // Force a failure on the first attempt to prove retry+backoff works.
    if (attemptCount === 1) {
      throw new Error('simulated transient failure');
    }
    return { ok: true, attempt: attemptCount };
  },
  { connection }
);

async function main() {
  console.log('--- BullMQ + Redis + Bun sanity check ---');

  await queue.add(
    'sanity-job',
    { hello: 'world' },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
    }
  );

  worker.on('completed', async (job) => {
    console.log(`[PASS] job ${job.id} completed after ${attemptCount} attempt(s)`);
    await worker.close();
    await queue.close();
    await connection.quit();
    process.exit(0);
  });

  worker.on('failed', (job, err) => {
    console.log(`[worker] job ${job?.id} failed this attempt: ${err.message}`);
  });

  // Safety timeout so this script never hangs a CI run.
  setTimeout(() => {
    console.error('[FAIL] sanity check timed out after 15s');
    process.exit(1);
  }, 15_000);
}

main();
