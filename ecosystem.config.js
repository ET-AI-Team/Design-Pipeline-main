// pm2 process definition for the API (Express + Socket.IO + both BullMQ
// workers, all in one process - see apps/api/src/server.ts). Not used in
// dev (`bun run dev:api` still uses --watch); this is the production
// entry point, run with:
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   # persist across a server reboot
//
// Requires pm2 installed on the host: `npm install -g pm2` (or `bun add
// -g pm2`) - not a project dependency, since it manages the process from
// outside it.
module.exports = {
  apps: [
    {
      name: 'design-pipeline-api',
      cwd: './apps/api',
      script: 'bun',
      args: 'run src/server.ts',
      // NODE_ENV=production here (not just in .env) matters at the OS-
      // process level: lib/logger.ts's level defaults to 'debug' and
      // lib/db.ts's dev-only global Prisma-client caching branch both key
      // off process.env.NODE_ENV directly, before .env is even loaded.
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      // A crash-loop (e.g. a genuinely broken deploy) should surface as
      // "stopped," not retry forever and flood the logs/provider APIs.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      out_file: './logs/api-out.log',
      error_file: './logs/api-error.log',
      time: true,
    },
  ],
};
