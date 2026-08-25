import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { jobsRouter } from './routes/jobs.routes';
import { errorHandler } from './middleware/error-handler';

export function createApp(): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.use('/api/v1/jobs', jobsRouter);

  // Must be registered last - Express only routes here on next(err).
  app.use(errorHandler);

  return app;
}
