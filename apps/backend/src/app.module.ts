import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { remoteJwks, type JwksSource } from '@taico/auth';
import { AuthExceptionFilter, AuthModule } from '@taico/auth/nest';
import { ActivitiesService } from './activities/activities.service';
import { ActivityIngestService } from './activities/activity-ingest.service';
import { ApiController } from './api/api.controller';
import { RESOURCE_SERVER, createFitResourceServer, protectedResources } from './auth/auth.setup';
import { FitUserGuard } from './auth/user.guard';
import { DomainErrorFilter } from './common/domain-error.filter';
import { APP_CONFIG, type AppConfig } from './config/env.config';
import { AUTH_FETCH, BrowserLoginService } from './connections/browser-login.service';
import { ConnectCallbackController } from './connections/connect-callback.controller';
import { ConnectionsRepository } from './connections/connections.repository';
import { ConnectionsService } from './connections/connections.service';
import { TokenVault } from './connections/token-vault';
import { dataSourceOptions } from './database/data-source-options';
import { UnitOfWork } from './database/unit-of-work';
import { HealthController } from './health/health.controller';
import { McpController } from './mcp/mcp.controller';
import { FitMcpServerFactory } from './mcp/fit-mcp.server';
import { ProviderRegistry, createProviderAdapters } from './providers/provider-registry';
import { PROVIDER_ADAPTERS } from './providers/provider.port';
import { GarminSyncService } from './sync/garmin-sync.service';
import { SyncService } from './sync/sync.service';
import { UsersRepository } from './users/users.repository';
import { UsersService } from './users/users.service';
import { WebhookHandlers } from './webhooks/webhook-handlers';
import { WebhookInboxService } from './webhooks/webhook-inbox.service';
import { WebhookWorker } from './webhooks/webhook-worker.service';
import { WebhooksController } from './webhooks/webhooks.controller';

export type AppModuleOptions = {
  config: AppConfig;
  /** Overrides Taico's remote JWKS (tests sign their own tokens) */
  jwks?: JwksSource;
  /** Overrides how Fit reaches Strava and Garmin (tests stand in fake providers) */
  providerFetch?: typeof fetch;
  /** Overrides how Fit reaches Taico's authorization server for the browser sign-in (tests stand in a fake) */
  authFetch?: typeof fetch;
};

@Global()
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const resourceServer = createFitResourceServer(config, options.jwks ?? remoteJwks(config.auth.jwksUrl));
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({ ...dataSourceOptions(config.database), retryAttempts: config.nodeEnv === 'test' ? 0 : 5 }),
        AuthModule.forRoot({
          resourceServer,
          metadata: { resources: protectedResources(config), authorizationServers: config.auth.authorizationServers },
        }),
      ],
      controllers: [HealthController, ApiController, McpController, ConnectCallbackController, WebhooksController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
        { provide: PROVIDER_ADAPTERS, useFactory: () => createProviderAdapters(config, options.providerFetch ?? fetch) },
        { provide: RESOURCE_SERVER, useValue: resourceServer },
        { provide: AUTH_FETCH, useValue: options.authFetch ?? fetch },
        BrowserLoginService,
        UnitOfWork,
        UsersRepository,
        UsersService,
        FitUserGuard,
        ProviderRegistry,
        TokenVault,
        ConnectionsRepository,
        ConnectionsService,
        ActivityIngestService,
        ActivitiesService,
        SyncService,
        GarminSyncService,
        WebhookInboxService,
        WebhookHandlers,
        WebhookWorker,
        FitMcpServerFactory,
      ],
    };
  }
}
