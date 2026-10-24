import { Injectable } from '@nestjs/common';
import type { AuthContext, TaicoClaims } from '@taico/auth';
import { ValidationError } from '../common/errors';
import { UsersRepository } from './users.repository';

/** Who a request is acting as, once its token has been validated and mapped to a Fit user */
export type CurrentUser = {
  id: string;
  issuer: string;
  subject: string;
  displayName: string | null;
  email: string | null;
};

@Injectable()
export class UsersService {
  constructor(private readonly users: UsersRepository) {}

  /**
   * Maps a validated access token to a Fit user. Identity is the token's
   * `iss` and `sub` only, both checked by @taico/auth. Nothing the caller
   * sends in a body or tool argument can choose the user.
   */
  async resolve(auth: AuthContext<Partial<TaicoClaims>>): Promise<CurrentUser> {
    const issuer = auth.claims.iss;
    const subject = auth.subject;
    if (!issuer || !subject) {
      throw new ValidationError('Access token has no issuer or subject');
    }
    const claims = auth.claims as Partial<TaicoClaims> & { name?: string };
    const user = await this.users.upsertIdentity({
      issuer,
      subject,
      displayName: truncate(claims.displayName ?? claims.name ?? claims.actor_slug ?? null, 255),
      email: truncate(claims.email ?? null, 320),
    });
    return { id: user.id, issuer, subject, displayName: user.displayName, email: user.email };
  }
}

function truncate(value: string | null | undefined, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}
