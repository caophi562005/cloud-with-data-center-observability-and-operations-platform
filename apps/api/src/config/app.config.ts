import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: Env['PORT'];
  webUrl: Env['WEB_URL'];
  agentMonitoring: {
    apiPublicUrl?: string;
    metricsWriteUrl?: string;
    secretKey?: string;
  };
}

export function createAppConfig(environment: Env): AppConfig {
  return {
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    webUrl: environment.WEB_URL,
    agentMonitoring: {
      apiPublicUrl: environment.AGENT_API_PUBLIC_URL,
      metricsWriteUrl: environment.AGENT_METRICS_WRITE_URL,
      secretKey: environment.AGENT_MONITORING_SECRET_KEY,
    },
  };
}

export const appConfig = registerAs('app', (): AppConfig =>
  createAppConfig(parseEnv()),
);

export default appConfig;
