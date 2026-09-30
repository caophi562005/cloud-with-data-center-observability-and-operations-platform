import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export interface DatabaseConfig {
  url: Env['DATABASE_URL'];
}

export function createDatabaseConfig(environment: Env): DatabaseConfig {
  return {
    url: environment.DATABASE_URL,
  };
}

export const databaseConfig = registerAs('database', (): DatabaseConfig =>
  createDatabaseConfig(parseEnv()),
);

export default databaseConfig;
