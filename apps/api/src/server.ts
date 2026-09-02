import { createServer } from 'node:http';
import { createApp } from './app';
import { attachSocketServer } from './realtime/socket-server';
import { startOrphanReaper } from './orchestrator/reap-orphaned-attempts';
import { logger } from './lib/logger';
import './stages/index'; // side-effect import - registers all pipeline stages
import './workers/pipeline-worker'; // side-effect import - starts the BullMQ workers

const app = createApp();
const httpServer = createServer(app);
attachSocketServer(httpServer);

// Recovers stage attempts abandoned in flight by a crash/restart - see
// reap-orphaned-attempts.ts. Started after the socket server so its
// escalations can emit real events.
startOrphanReaper();

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () => {
  logger.info({ port }, 'server_started');
});
