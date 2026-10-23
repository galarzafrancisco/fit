import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/** Runs a function inside one database transaction */
@Injectable()
export class UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  get manager(): EntityManager {
    return this.dataSource.manager;
  }
}
