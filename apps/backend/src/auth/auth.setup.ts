import { createResourceServer, remoteJwks, resourceAudience, type JwksSource, type ProtectedResource, type ResourceServer } from '@taico/auth';
import type { AppConfig } from '../config/env.config';

export const RESOURCE_SERVER = Symbol('RESOURCE_SERVER');

/**
 * Fit's two protected resources. A token minted for one is refused on the
 * other (resourceAudience binds each token to its own URL and below).
 */
export function protectedResources(config: AppConfig): ProtectedResource[] {
  return [
    { id: 'fit-mcp', identifier: 'mcp', resourceUrl: config.auth.mcpResourceUrl, name: 'Fit MCP', scopes: [] },
    { id: 'fit-api', identifier: 'api', resourceUrl: config.auth.apiResourceUrl, name: 'Fit REST API', scopes: [] },
  ];
}

/**
 * Verifies Taico access tokens: signature against Taico's JWKS, `iss`,
 * `exp`, and an audience naming the resource being called. Fit has no
 * logins of its own.
 */
export function createFitResourceServer(config: AppConfig, jwks: JwksSource = remoteJwks(config.auth.jwksUrl)): ResourceServer {
  return createResourceServer({
    issuer: config.auth.issuer,
    jwks,
    audience: resourceAudience(config.auth.mcpResourceUrl, config.auth.apiResourceUrl),
    baseUrl: config.publicBaseUrl,
    realm: 'fit',
  });
}
