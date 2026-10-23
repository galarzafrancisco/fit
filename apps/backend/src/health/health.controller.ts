import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Liveness/readiness: the database answers. Also reports the webhook backlog (counts only, no user data) */
@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async health() {
    const rows: Array<{ status: string; count: string }> = await this.dataSource.query(
      `SELECT status, count(*)::text AS count FROM webhook_deliveries WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
    );
    const backlog = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return { status: 'ok', webhooks: { pending: backlog.pending ?? 0, processing: backlog.processing ?? 0, failed: backlog.failed ?? 0 } };
  }
}
