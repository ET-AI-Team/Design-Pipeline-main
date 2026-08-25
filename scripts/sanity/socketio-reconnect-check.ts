/**
 * Disposable sanity check - not part of the application.
 * Starts a Socket.IO server + client in the same process, kills the
 * server mid-session, restarts it, and confirms the client reconnects.
 * Run with: bun run scripts/sanity/socketio-reconnect-check.ts
 */
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

const PORT = 4099;

function startServer() {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    socket.emit('welcome', { serverStartedAt: Date.now() });
  });
  httpServer.listen(PORT);
  return { io, httpServer };
}

async function main() {
  console.log('--- Socket.IO reconnect sanity check ---');
  let { io, httpServer } = startServer();

  const client = ioClient(`http://localhost:${PORT}`, {
    reconnection: true,
    reconnectionDelay: 300,
  });

  let welcomeCount = 0;
  let reconnectSeen = false;

  client.on('welcome', () => {
    welcomeCount += 1;
    console.log(`[client] welcome #${welcomeCount}`);

    if (welcomeCount === 1) {
      // Kill the server mid-session to force a disconnect.
      console.log('[test] killing server to force disconnect...');
      io.close();
      httpServer.close();
      setTimeout(() => {
        console.log('[test] restarting server...');
        const restarted = startServer();
        io = restarted.io;
        httpServer = restarted.httpServer;
      }, 1000);
    }

    if (welcomeCount === 2 && reconnectSeen) {
      console.log('[PASS] client reconnected and received a fresh welcome event');
      client.close();
      io.close();
      httpServer.close();
      process.exit(0);
    }
  });

  // Reconnection events fire on the Manager (client.io), not the Socket
  // instance itself — client.on('reconnect', ...) never fires. This is a
  // real gap found while running this exact script from the readme plan.
  client.io.on('reconnect', (attempt) => {
    reconnectSeen = true;
    console.log(`[client] reconnected after ${attempt} attempt(s)`);
  });

  setTimeout(() => {
    console.error('[FAIL] sanity check timed out after 15s');
    process.exit(1);
  }, 15_000);
}

main();
