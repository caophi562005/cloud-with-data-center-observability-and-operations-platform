import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: Env['PORT'];
  webUrl: Env['WEB_URL'];
}

export function createAppConfig(environment: Env): AppConfig {
  return {
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    webUrl: environment.WEB_URL,
  };
}

export const appConfig = registerAs('app', (): AppConfig =>
  createAppConfig(parseEnv()),
);

export default appConfig;
