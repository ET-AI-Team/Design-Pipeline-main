import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const redisConnection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ's blocking connection usage
});

/** Handles Nano Banana Flash / Gemini Pro calls - LLD §4. */
export const imageGenerationQueue = new Queue('image-generation', { connection: redisConnection });

/** Handles GPT-4.1 vision calls (QA scoring, logo detection) - LLD §4. */
export const visionScoringQueue = new Queue('vision-scoring', { connection: redisConnection });

export interface StageJobPayload {
  jobId: string;
  stage: string;
  attemptNumber: number;
  prompt: string;
  inputAssetUrl?: string;
}
