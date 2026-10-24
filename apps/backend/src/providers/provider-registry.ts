import { PROVIDERS, type Provider } from '@fit/activity-model';
import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../common/errors';
import type { AppConfig } from '../config/env.config';
import { GarminAdapter } from './garmin/garmin.adapter';
import { PROVIDER_ADAPTERS, type ProviderAdapter } from './provider.port';
import { StravaAdapter } from './strava/strava.adapter';

/** Builds the adapters. `fetchImpl` is the only way Fit reaches a provider (tests pass a fake) */
export function createProviderAdapters(config: AppConfig, fetchImpl: typeof fetch): ProviderAdapter[] {
  return [new StravaAdapter(config, fetchImpl), new GarminAdapter(config, fetchImpl)];
}

@Injectable()
export class ProviderRegistry {
  private readonly byName: Map<Provider, ProviderAdapter>;

  constructor(@Inject(PROVIDER_ADAPTERS) adapters: ProviderAdapter[]) {
    this.byName = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    for (const provider of PROVIDERS) if (!this.byName.has(provider)) throw new Error(`No adapter registered for ${provider}`);
  }

  get(provider: Provider): ProviderAdapter {
    const adapter = this.byName.get(provider);
    if (!adapter) throw new ValidationError(`Unknown provider ${provider}`);
    return adapter;
  }

  all(): ProviderAdapter[] {
    return [...this.byName.values()];
  }

  get strava(): StravaAdapter {
    return this.get('strava') as StravaAdapter;
  }

  get garmin(): GarminAdapter {
    return this.get('garmin') as GarminAdapter;
  }
}
