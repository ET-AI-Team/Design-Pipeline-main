import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from '@pipeline/shared-types';
import { approveJob, rejectJob } from './approval-handler';
import { logger } from '../lib/logger';

export type TypedSocketServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

let ioInstance: TypedSocketServer | null = null;

export const GLOBAL_ROOM = 'global';

export function attachSocketServer(httpServer: HttpServer): TypedSocketServer {
  const io: TypedSocketServer = new Server(httpServer, { cors: { origin: '*' } });
  ioInstance = io;

  io.on('connection', (socket) => {
    socket.on('join:job', ({ jobId }) => {
      socket.join(`job:${jobId}`);
    });

    socket.on('join:global', () => {
      socket.join(GLOBAL_ROOM);
    });

    socket.on('job:approval_response', async ({ jobId, decision, comment }) => {
      try {
        if (decision === 'approve') await approveJob(jobId);
        else await rejectJob(jobId, comment);
      } catch (err) {
        logger.error({ err, jobId }, 'approval_response_failed');
      }
    });
  });

  return io;
}

/** Used by emitters.ts - the only other module allowed to reach into
 *  the io instance directly, per the "single place events are emitted
 *  from" principle. */
export function getSocketServer(): TypedSocketServer {
  if (!ioInstance) throw new Error('Socket server not yet attached - call attachSocketServer() first');
  return ioInstance;
}
