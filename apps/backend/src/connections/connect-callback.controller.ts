import { Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SyncService } from '../sync/sync.service';
import { ConnectCallbackError, ConnectionsService, capitalize } from './connections.service';

/**
 * Where a provider sends the browser back after the user approves Fit.
 * Not behind Taico auth: the single-use `state` created by connect_provider
 * identifies the Fit user. Answers a small self-contained HTML page; there
 * is no web app yet (see docs/architecture.md).
 */
@Controller('connect')
export class ConnectCallbackController {
  private readonly logger = new Logger('ConnectCallback');

  constructor(
    private readonly connections: ConnectionsService,
    private readonly sync: SyncService,
  ) {}

  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    try {
      const { connection } = await this.connections.completeConnect({ provider, state: text('state'), code: text('code'), error: text('error'), scope: text('scope') });
      this.sync.startInitialSync(connection);
      const name = capitalize(connection.provider);
      res
        .status(200)
        .type('html')
        .send(
          page(
            `${name} connected`,
            `Fit is importing your ${name} activities now. You can close this tab and ask your AI assistant about your training.` +
              (connection.provider === 'garmin' ? ' Garmin sends history in the background, so older activities can take a while to appear.' : ''),
          ),
        );
    } catch (error) {
      if (error instanceof ConnectCallbackError) {
        res.status(400).type('html').send(page('Connection not completed', error.message));
        return;
      }
      this.logger.error(`OAuth callback for ${provider} failed`, (error as Error).stack);
      res.status(502).type('html').send(page('Connection not completed', 'Something went wrong talking to the provider. Please try again in a few minutes.'));
    }
  }
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Fit</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1d2433;line-height:1.5}h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
