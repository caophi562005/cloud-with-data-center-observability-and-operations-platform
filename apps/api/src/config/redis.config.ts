import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export interface RedisConfig {
  url: Env['REDIS_URL'];
}

export function createRedisConfig(environment: Env): RedisConfig {
  return {
    url: environment.REDIS_URL,
  };
}

export const redisConfig = registerAs('redis', (): RedisConfig =>
  createRedisConfig(parseEnv()),
);

export default redisConfig;
