import { loadEnv, logger } from '@ai-orchestrator/shared';
import { createDatabase, runMigrations } from '@ai-orchestrator/db';
import { buildServer } from './server.js';
import { pathToFileURL } from 'node:url';

export async function bootstrap(): Promise<void> {
  const env = loadEnv();

  logger.info('Initializing SQLite database...', { databasePath: env.DATABASE_PATH });
  const db = createDatabase(env.DATABASE_PATH);

  logger.info('Running database migrations...');
  const appliedMigrations = runMigrations(db);
  logger.info(`Applied ${appliedMigrations.length} migration(s).`, { appliedMigrations });

  const server = await buildServer({
    db,
    logger: env.LOG_LEVEL !== 'info' ? { level: env.LOG_LEVEL } : true,
    config: env,
    autoRecover: true,
  });

  const address = await server.listen({
    port: env.PORT,
    host: env.HOST,
  });

  logger.info(`Orchestrator server listening at ${address}`, {
    port: env.PORT,
    host: env.HOST,
    nodeEnv: env.NODE_ENV,
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`, { signal });
    try {
      await server.close();
      db.close();
      logger.info('Orchestrator server and database closed cleanly.');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Automatically start if executed directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().catch((err) => {
    logger.error('Fatal error during Orchestrator bootstrap:', err);
    process.exit(1);
  });
}
