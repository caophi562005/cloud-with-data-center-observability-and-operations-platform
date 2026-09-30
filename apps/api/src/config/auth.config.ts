import { registerAs } from '@nestjs/config';
import { parseEnv, type Env } from './env.schema.js';

export interface AuthConfig {
  region: Env['COGNITO_REGION'];
  userPoolId: Env['COGNITO_USER_POOL_ID'];
  clientId: Env['COGNITO_CLIENT_ID'];
  clientSecret: Env['COGNITO_CLIENT_SECRET'];
}

export function createAuthConfig(environment: Env): AuthConfig {
  return {
    region: environment.COGNITO_REGION,
    userPoolId: environment.COGNITO_USER_POOL_ID,
    clientId: environment.COGNITO_CLIENT_ID,
    clientSecret: environment.COGNITO_CLIENT_SECRET,
  };
}

export const authConfig = registerAs('auth', (): AuthConfig =>
  createAuthConfig(parseEnv()),
);

export default authConfig;
