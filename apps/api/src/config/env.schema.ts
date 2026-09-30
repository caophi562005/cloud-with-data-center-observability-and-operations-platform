import { z } from 'zod';

const environmentKeys = [
  'NODE_ENV',
  'PORT',
  'WEB_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'COGNITO_REGION',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_CLIENT_SECRET',
] as const;

const awsRegionPattern = /^[a-z]{2}(?:-[a-z0-9]+)*-\d+$/;
const cognitoUserPoolIdPattern = /^[a-z]{2}(?:-[a-z0-9]+)*-\d+_[A-Za-z0-9]+$/;

function usesAllowedProtocol(value: string, protocols: readonly string[]) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const protocolUrl = (protocols: readonly string[], message: string) =>
  z.url().refine((value) => usesAllowedProtocol(value, protocols), { message });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65_535),
    WEB_URL: protocolUrl(['http:', 'https:'], 'WEB_URL must use http or https'),
    DATABASE_URL: protocolUrl(
      ['postgres:', 'postgresql:'],
      'DATABASE_URL must use postgres or postgresql',
    ),
    REDIS_URL: protocolUrl(
      ['redis:', 'rediss:'],
      'REDIS_URL must use redis or rediss',
    ),
    COGNITO_REGION: z
      .string()
      .min(1)
      .regex(awsRegionPattern, 'COGNITO_REGION must be a valid AWS region'),
    COGNITO_USER_POOL_ID: z
      .string()
      .min(1)
      .regex(
        cognitoUserPoolIdPattern,
        'COGNITO_USER_POOL_ID must include a region prefix',
      ),
    COGNITO_CLIENT_ID: z.string().min(1),
    COGNITO_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((environment, context) => {
    if (
      !environment.COGNITO_USER_POOL_ID.startsWith(
        `${environment.COGNITO_REGION}_`,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COGNITO_USER_POOL_ID'],
        message: 'COGNITO_USER_POOL_ID must use the configured COGNITO_REGION',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parse only the environment variables owned by the API. This keeps strict
 * validation useful even when the host process has unrelated system variables.
 */
export function parseEnv(input: unknown = process.env): Env {
  if (typeof input !== 'object' || input === null) {
    return envSchema.parse(input);
  }

  const source = input as Record<string, unknown>;
  const ownedEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, source[key]]),
  );

  return envSchema.parse(ownedEnvironment);
}
