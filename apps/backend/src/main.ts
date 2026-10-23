import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { loadConfig } from './config/env.config';
import { startDatabase } from './database/in-memory-database';

async function bootstrap(): Promise<void> {
  const loaded = loadConfig();
  const logger = new Logger('Fit');
  const running = await startDatabase(loaded.database);
  const config = { ...loaded, database: running.database };
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ config }), { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port);

  logger.log(`Listening on ${config.publicBaseUrl} (MCP /mcp, REST /api, health /health)`);
  if (loaded.database.driver === 'memory') {
    logger.warn('Database: IN-MEMORY PGlite (DATABASE_MODE=memory). NOT DURABLE: all data is lost on every restart.');
  } else {
    logger.log(`Database: ${config.database.driver === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `embedded PGlite at ${config.database.dataDir}`}`);
  }
  logger.log(`Taico issuer: ${config.auth.issuer} (JWKS ${config.auth.jwksUrl})`);
  if (config.tokenEncryptionKeyEphemeral) logger.warn('TOKEN_ENCRYPTION_KEY unset: using a per-process key; provider connections stop working on restart');
  logger.log(
    config.strava.clientId
      ? `Strava: enabled (callback ${config.strava.redirectUri}; webhook ${config.strava.webhookUrl ? 'configured' : 'off: set STRAVA_WEBHOOK_SECRET'})`
      : 'Strava: disabled (set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, see docs/providers/strava.md)',
  );
  logger.log(
    config.garmin.clientId
      ? `Garmin: enabled (callback ${config.garmin.redirectUri}; webhook ${config.garmin.webhookUrl ? 'configured' : 'off: set GARMIN_WEBHOOK_SECRET'})`
      : 'Garmin: disabled (needs an approved Garmin Connect Developer Program app, see docs/providers/garmin.md)',
  );
  logger.log(`Webhook worker: ${config.webhooks.workerEnabled ? `on (every ${config.webhooks.pollIntervalMs} ms)` : 'off'}`);
}

void bootstrap();
