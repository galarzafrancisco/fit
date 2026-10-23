import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';

/**
 * HTTP settings shared by main.ts and the test app. Garmin pushes batches of
 * summaries, so JSON bodies may be up to 5 MB; Strava events are tiny.
 */
export function configureApp(app: INestApplication): void {
  const http = app as NestExpressApplication;
  http.use(express.json({ limit: '5mb' }));
  http.use(express.urlencoded({ extended: false, limit: '100kb' }));
  http.disable('x-powered-by');
}
