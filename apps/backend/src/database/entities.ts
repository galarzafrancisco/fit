import { ActivityEntity, ActivityPayloadEntity } from '../activities/activity.entities';
import { OAuthStateEntity, ProviderConnectionEntity } from '../connections/connection.entities';
import { SyncRunEntity } from '../sync/sync-run.entity';
import { UserEntity } from '../users/user.entity';
import { WebhookDeliveryEntity } from '../webhooks/webhook-delivery.entity';
import { InitialSchema1761200000000 } from './migrations/1761200000000-InitialSchema';
import { GarminPersonalApi1761300000000 } from './migrations/1761300000000-GarminPersonalApi';
import { GarminSyncLock1761400000000 } from './migrations/1761400000000-GarminSyncLock';

export const ENTITIES = [UserEntity, ProviderConnectionEntity, OAuthStateEntity, ActivityEntity, ActivityPayloadEntity, WebhookDeliveryEntity, SyncRunEntity];

/** In chronological order. Migrations run on startup; the schema is never synchronized from entities */
export const MIGRATIONS = [InitialSchema1761200000000, GarminPersonalApi1761300000000, GarminSyncLock1761400000000];
