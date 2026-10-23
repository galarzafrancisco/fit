import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A Fit user. Fit has no logins: a user is whoever a validated Taico
 * access token says it is, identified by the token's issuer and subject
 * (`iss`, `sub`). The row is created the first time a user calls the API.
 */
@Entity('users')
@Index('UQ_users_issuer_subject', ['issuer', 'subject'], { unique: true })
export class UserEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 500 })
  issuer: string;

  @Column({ type: 'varchar', length: 255 })
  subject: string;

  /** Display name from the token, refreshed on each call; informational only */
  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
