import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { UserEntity } from './user.entity';

@Injectable()
export class UsersRepository {
  constructor(private readonly uow: UnitOfWork) {}

  findById(id: string, manager: EntityManager = this.uow.manager): Promise<UserEntity | null> {
    return manager.findOne(UserEntity, { where: { id } });
  }

  findByIdentity(issuer: string, subject: string, manager: EntityManager = this.uow.manager): Promise<UserEntity | null> {
    return manager.findOne(UserEntity, { where: { issuer, subject } });
  }

  /**
   * Returns the user for (issuer, subject), creating it if needed. Safe when
   * two first requests race: the unique index lets one insert win.
   */
  async upsertIdentity(
    identity: { issuer: string; subject: string; displayName: string | null; email: string | null },
  ): Promise<UserEntity> {
    const manager = this.uow.manager;
    await manager
      .createQueryBuilder()
      .insert()
      .into(UserEntity)
      .values({ id: randomUUID(), ...identity })
      .orIgnore()
      .execute();
    const user = await this.findByIdentity(identity.issuer, identity.subject, manager);
    if (!user) throw new Error('User upsert failed');
    if (user.displayName !== identity.displayName || user.email !== identity.email) {
      user.displayName = identity.displayName;
      user.email = identity.email;
      await manager.save(UserEntity, user);
    }
    return user;
  }
}
