import { mkdirSync } from 'node:fs';
import type { DataSourceOptions } from 'typeorm';
import { PGliteDriver } from 'typeorm-pglite';
import type { AppConfig } from '../config/env.config';
import { ENTITIES, MIGRATIONS } from './entities';

/**
 * Postgres when DATABASE_URL is set; otherwise embedded PGlite (Postgres
 * compiled to WASM) so development and tests need no database server and use
 * the same SQL dialect and migrations. DATABASE_MODE=memory arrives here
 * already resolved to a Postgres URL (see in-memory-database.ts). Migrations run on startup; the schema
 * is never synchronized from entities.
 */
export function dataSourceOptions(database: AppConfig['database']): DataSourceOptions {
  const common = {
    type: 'postgres' as const,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsRun: true,
    synchronize: false,
  };
  if (database.driver === 'postgres') {
    return {
      ...common,
      url: database.url,
      ssl: database.ssl ? { rejectUnauthorized: true } : false,
      extra: { max: database.poolMax },
    };
  }
  if (database.driver === 'memory') {
    // The embedded server must be running first; it is async and owns a port
    throw new Error('DATABASE_MODE=memory must be resolved with startDatabase() (database/in-memory-database.ts) before building data source options');
  }
  if (!database.dataDir.startsWith('memory://')) {
    mkdirSync(database.dataDir, { recursive: true });
  }
  return {
    ...common,
    driver: new PGliteDriver({ dataDir: database.dataDir }).driver,
  };
}
