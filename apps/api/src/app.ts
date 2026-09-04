import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { jobsRouter } from './routes/jobs.routes';
import { errorHandler } from './middleware/error-handler';

export function createApp(): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(express.json());

  // Liveness probe for the deploy pipeline. Deliberately does NOT touch
  // the database: its question is "did this process come back up and
  // bind its port", and the deploy rolls back on a failure. Answering it
  // with a real query would make a momentarily slow Supabase look like a
  // bad release and revert healthy code. It is also the only route that
  // costs nothing - /api/v1/jobs was the alternative, and that is a real
  // paginated query measured at 1.0-1.9s against production.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use('/api/v1/jobs', jobsRouter);

  // Must be registered last - Express only routes here on next(err).
  app.use(errorHandler);

  return app;
}
