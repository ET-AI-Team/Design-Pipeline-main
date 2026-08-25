import { io, type Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@pipeline/shared-types';

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('/', {
  autoConnect: true,
  reconnection: true,
});
