import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export type SnsAlertsConfig = { enabled: false } | { enabled: true; topicArn: string; region: string; source: 'metrics-primary' };
export function createSnsAlertsConfig(environment: Env): SnsAlertsConfig {
  if (!environment.SNS_ALERTS_ENABLED) return { enabled: false };
  // parseEnv enforces topic/region consistency before configuration is loaded.
  if (!environment.SNS_ALERTS_TOPIC_ARN || !environment.SNS_ALERTS_REGION) throw new Error('Invalid SNS alert configuration');
  return { enabled: true, topicArn: environment.SNS_ALERTS_TOPIC_ARN, region: environment.SNS_ALERTS_REGION, source: 'metrics-primary' };
}
export const snsAlertsConfig = registerAs('snsAlerts', (): SnsAlertsConfig => createSnsAlertsConfig(parseEnv()));
