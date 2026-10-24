import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadConfig } from '../config/env.config';
import { dataSourceOptions } from './data-source-options';

/** For the TypeORM CLI (migration:run / migration:revert) */
export default new DataSource({ ...dataSourceOptions(loadConfig().database), migrationsRun: false });
