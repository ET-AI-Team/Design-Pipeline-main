import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Singleton PrismaClient. In dev, Bun's --watch restarts the module on
 * every file change; without the global cache below, each restart would
 * open a fresh pool of DB connections and never close the old ones.
 */
export const db: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV === 'development') {
  global.__prisma = db;
}
