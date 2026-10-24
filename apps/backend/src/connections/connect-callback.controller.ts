import { Body, Controller, Get, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GarminSyncService } from '../sync/garmin-sync.service';
import { SyncService } from '../sync/sync.service';
import { BrowserLoginService, LOGIN_COOKIE, SESSION_COOKIE, readCookie } from './browser-login.service';
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
    private readonly garminSync: GarminSyncService,
    private readonly login: BrowserLoginService,
  ) {}

  /**
   * Garmin Personal API key page. The link (hashed in the database) says which
   * Fit account the key is for; it is not proof of who is at the keyboard.
   * Before the form is shown the browser signs in with Taico (authorization
   * code + PKCE, see BrowserLoginService) and the verified `(iss, sub)` must
   * equal the account the link was issued to.
   */
  @Get('garmin')
  async garminForm(@Query('link') link: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    securityHeaders(res);
    const value = typeof link === 'string' ? link : undefined;
    const preview = await this.connections.previewGarminLink(value);
    if (!preview || !value) {
      res
        .status(400)
        .type('html')
        .send(page('Link not valid', 'This link is invalid, expired or already used. Ask your AI assistant for a new one with connect_garmin.'));
      return;
    }
    const identity = this.login.session(readCookie(req.headers.cookie, SESSION_COOKIE), value);
    if (identity && identity.issuer === preview.issuer && identity.subject === preview.subject) {
      res.status(200).type('html').send(keyPage(preview.label, value));
      return;
    }
    try {
      const started = await this.login.begin(value);
      res.cookie(LOGIN_COOKIE, started.cookie, this.cookieOptions(started.maxAgeMs));
      res.redirect(302, started.url);
    } catch (error) {
      this.logger.error('Could not start the Taico sign-in', (error as Error).message);
      res.status(502).type('html').send(page('Sign-in unavailable', 'Fit could not reach the sign-in service. Try the link again in a few minutes.'));
    }
  }

  /** Where Taico sends the browser back after sign-in */
  @Get('garmin/auth')
  async garminAuth(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    securityHeaders(res);
    const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined);
    res.clearCookie(LOGIN_COOKIE, this.cookieOptions());
    const result = await this.login.complete(readCookie(req.headers.cookie, LOGIN_COOKIE), { code: text('code'), state: text('state') });
    if (!result) {
      res.status(400).type('html').send(page('Sign-in not completed', 'Signing in did not complete. Open the link from your AI assistant again.'));
      return;
    }
    res.cookie(SESSION_COOKIE, result.sessionCookie, this.cookieOptions(result.maxAgeMs));
    // Back to the key page, which now finds the session and compares the identity with the link's account
    res.redirect(302, `/connect/garmin?link=${encodeURIComponent(result.link)}`);
  }

  @Post('garmin')
  async garminSubmit(@Body() body: Record<string, unknown> | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    securityHeaders(res);
    const text = (key: string) => (typeof body?.[key] === 'string' ? (body[key] as string) : undefined);
    try {
      const link = text('link');
      const identity = link ? this.login.session(readCookie(req.headers.cookie, SESSION_COOKIE), link) : null;
      const { connection } = await this.connections.completeGarminKey(link, text('apiKey'), identity);
      res.clearCookie(SESSION_COOKIE, this.cookieOptions());
      this.garminSync.startInitialSync(connection);
      res
        .status(200)
        .type('html')
        .send(
          page(
            'Garmin connected',
            'Your Garmin Personal API key is stored encrypted and will not be shown again. Fit is importing your activities, newest first, and will keep checking for new ones. You can close this tab and ask your AI assistant about your training.',
          ),
        );
    } catch (error) {
      if (error instanceof ConnectCallbackError) {
        res.status(400).type('html').send(page('Connection not completed', error.message));
        return;
      }
      this.logger.error('Garmin key submission failed', (error as Error).constructor.name);
      res
        .status(502)
        .type('html')
        .send(
          page('Connection not completed', 'Something went wrong talking to Garmin. Ask for a new link with connect_garmin and try again in a few minutes.'),
        );
    }
  }

  private cookieOptions(maxAgeMs?: number) {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.login.secureCookies, path: '/connect/garmin', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) };
  }

  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined);
    securityHeaders(res);
    try {
      const { connection } = await this.connections.completeConnect({
        provider,
        state: text('state'),
        code: text('code'),
        error: text('error'),
        scope: text('scope'),
      });
      this.sync.startInitialSync(connection);
      const name = capitalize(connection.provider);
      res
        .status(200)
        .type('html')
        .send(
          page(`${name} connected`, `Fit is importing your ${name} activities now. You can close this tab and ask your AI assistant about your training.` + ''),
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

function securityHeaders(res: Response): void {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
}

function keyPage(label: string, link: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Garmin · Fit</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:10vh auto;padding:0 1.5rem;color:#1d2433;line-height:1.5}h1{font-size:1.4rem}input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;font:inherit}button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit}small{color:#556}</style></head>
<body><h1>Connect Garmin to Fit</h1>
<p>This attaches a Garmin Connect Personal API key to the Fit account <strong>${escapeHtml(label)}</strong>. If that is not you, close this page.</p>
<form method="post" action="/connect/garmin" autocomplete="off">
<input type="hidden" name="link" value="${escapeHtml(link)}">
<label for="apiKey">Your Garmin Personal API key</label>
<input id="apiKey" name="apiKey" type="password" required autocomplete="off" autocapitalize="off" spellcheck="false">
<button type="submit">Save key</button>
</form>
<p><small>Create the key in Garmin Connect on the web (Account &rarr; Personal API Key). It is personal: use your own, only for your own data. Fit validates it with Garmin, stores it encrypted and never shows it again. Deleting the key in Garmin Connect revokes Fit's access.</small></p></body></html>`;
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Fit</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1d2433;line-height:1.5}h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
