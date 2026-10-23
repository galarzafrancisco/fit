import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { WebhookInboxService } from './webhook-inbox.service';

/**
 * Provider webhook endpoints. Intentionally NOT behind Taico auth: providers
 * have no Taico token. Each URL ends in a per-provider secret (see
 * docs/webhooks.md) checked before anything else. Events are stored and
 * acknowledged; webhook-worker.service.ts processes them.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly inbox: WebhookInboxService) {}

  /** Strava subscription validation: echo hub.challenge within 2 seconds */
  @Get('strava/:secret')
  stravaChallenge(@Param('secret') secret: string, @Query() query: Record<string, unknown>) {
    return this.inbox.stravaChallenge(secret, query);
  }

  @Post('strava/:secret')
  @HttpCode(200)
  strava(@Param('secret') secret: string, @Body() body: unknown) {
    return this.inbox.receiveStrava(secret, body);
  }

  /** Garmin Push and Ping notifications (all summary types share this URL) */
  @Post('garmin/:secret')
  @HttpCode(200)
  garmin(@Param('secret') secret: string, @Body() body: unknown) {
    return this.inbox.receiveGarmin(secret, body);
  }
}
