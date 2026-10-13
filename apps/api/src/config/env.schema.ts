import { z } from 'zod';

export const DEFAULT_VM_HEALTH_POLICY = {
  staleSeconds: 300,
  cpuWarning: 80,
  memoryWarning: 85,
  diskWarning: 85,
  critical: 95,
} as const;
const vmHealthKeys = [
  'VM_DISCONNECTED_AFTER_SECONDS',
  'VM_HEALTH_CPU_WARNING_PERCENT',
  'VM_HEALTH_MEMORY_WARNING_PERCENT',
  'VM_HEALTH_DISK_WARNING_PERCENT',
  'VM_HEALTH_CRITICAL_PERCENT',
] as const;
const healthPercent = z.coerce.number().finite().positive().max(100);

const metricsQueryKeys = [
  'METRICS_QUERY_URL',
  'METRICS_USERNAME',
  'METRICS_QUERY_TOKEN',
  'METRICS_QUERY_AUTH_MODE',
] as const;

const environmentKeys = [
  'NODE_ENV',
  'PORT',
  'WEB_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'ENROLLMENT_TOKEN_CACHE_KEY',
  'AGENT_API_PUBLIC_URL',
  'AGENT_METRICS_WRITE_URL',
  'AGENT_MONITORING_SECRET_KEY',
  'COGNITO_REGION',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_CLIENT_SECRET',
  'SNS_ALERTS_ENABLED',
  'SNS_ALERTS_TOPIC_ARN',
  'SNS_ALERTS_REGION',
  ...metricsQueryKeys,
  ...vmHealthKeys,
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

const metricsQueryUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);

    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) &&
      !url.username &&
      !url.password &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}, 'METRICS_QUERY_URL must be an HTTPS base URL without credentials, query or fragment (HTTP allowed only on loopback)');

const agentHttpsUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !/[?#\x00-\x20\x7f$]/.test(value) && !/%24/i.test(value) && !url.pathname.includes('@');
  } catch {
    return false;
  }
}, 'Agent endpoints must use HTTPS without credentials, query, fragment or environment expansion');
const agentApiOrigin = agentHttpsUrl.refine((value) => {
  try {
    return new URL(value).pathname === '/';
  } catch {
    return false;
  }
}, 'AGENT_API_PUBLIC_URL must be an HTTPS origin without a path');

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
    ENROLLMENT_TOKEN_CACHE_KEY: z
      .string()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        'ENROLLMENT_TOKEN_CACHE_KEY must be a 32-byte hex key',
      )
      .optional(),
    // Optional at legacy startup; monitoring operations assert all three before use.
    AGENT_API_PUBLIC_URL: agentApiOrigin.optional(),
    AGENT_METRICS_WRITE_URL: agentHttpsUrl.optional(),
    AGENT_MONITORING_SECRET_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/,
      'AGENT_MONITORING_SECRET_KEY must be a 32-byte hex key').optional(),
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
    SNS_ALERTS_ENABLED: z.preprocess(
      (value) => value === undefined || value === '' ? false : value === 'true' ? true : value === 'false' ? false : value,
      z.boolean(),
    ),
    SNS_ALERTS_TOPIC_ARN: z.string().regex(/^arn:aws:sns:[a-z]{2}-[a-z]+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/).optional(),
    SNS_ALERTS_REGION: z.string().regex(awsRegionPattern).optional(),
    VM_DISCONNECTED_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(604800)
      .default(DEFAULT_VM_HEALTH_POLICY.staleSeconds),
    VM_HEALTH_CPU_WARNING_PERCENT: healthPercent.default(
      DEFAULT_VM_HEALTH_POLICY.cpuWarning,
    ),
    VM_HEALTH_MEMORY_WARNING_PERCENT: healthPercent.default(
      DEFAULT_VM_HEALTH_POLICY.memoryWarning,
    ),
    VM_HEALTH_DISK_WARNING_PERCENT: healthPercent.default(
      DEFAULT_VM_HEALTH_POLICY.diskWarning,
    ),
    VM_HEALTH_CRITICAL_PERCENT: healthPercent.default(
      DEFAULT_VM_HEALTH_POLICY.critical,
    ),
    METRICS_QUERY_URL: metricsQueryUrl.optional(),
    METRICS_QUERY_AUTH_MODE: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? value.trim().toLowerCase() || undefined
          : value,
      z.enum(['none', 'basic', 'bearer']).optional(),
    ),
    // Only credentials selected by the query mode are validated below.
    METRICS_USERNAME: z.string().optional(),
    METRICS_QUERY_TOKEN: z.string().optional(),
  })
  .strict()
  .superRefine((environment, context) => {
    if (environment.SNS_ALERTS_ENABLED && (!environment.SNS_ALERTS_REGION || !environment.SNS_ALERTS_TOPIC_ARN ||
      environment.SNS_ALERTS_TOPIC_ARN.split(':')[3] !== environment.SNS_ALERTS_REGION)) {
      context.addIssue({ code: 'custom', path: ['SNS_ALERTS_TOPIC_ARN'], message: 'Enabled SNS alerts require a Standard topic matching the configured region' });
    }
    if (
      environment.VM_HEALTH_CRITICAL_PERCENT <
      Math.max(
        environment.VM_HEALTH_CPU_WARNING_PERCENT,
        environment.VM_HEALTH_MEMORY_WARNING_PERCENT,
        environment.VM_HEALTH_DISK_WARNING_PERCENT,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['VM_HEALTH_CRITICAL_PERCENT'],
        message: 'Critical threshold must be at least all warning thresholds',
      });
    }
    if (metricsQueryKeys.some((key) => environment[key] !== undefined)) {
      const mode = environment.METRICS_QUERY_AUTH_MODE ?? 'basic';
      const requiredKeys = [
        'METRICS_QUERY_URL',
        ...(mode === 'basic' ? (['METRICS_USERNAME'] as const) : []),
        ...(mode !== 'none' ? (['METRICS_QUERY_TOKEN'] as const) : []),
      ] as const;
      for (const key of requiredKeys) {
        if (environment[key] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when metrics query is configured`,
          });
        }
      }
      const username = environment.METRICS_USERNAME;
      const token = environment.METRICS_QUERY_TOKEN;
      if (
        mode === 'basic' &&
        username !== undefined &&
        (!username.trim() ||
          username.includes(':') ||
          // oxlint-disable-next-line no-control-regex -- Intentionally reject ASCII control bytes in Basic usernames.
          /[\x00-\x1f\x7f]/.test(username))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['METRICS_USERNAME'],
          message: 'METRICS_USERNAME must be a valid Basic Auth username',
        });
      }
      if (
        mode !== 'none' &&
        token !== undefined &&
        (!token ||
          token !== token.trim() ||
          // oxlint-disable-next-line no-control-regex -- Intentionally reject ASCII control bytes in query tokens.
          /[\x00-\x1f\x7f]/.test(token) ||
          (mode === 'bearer' && /[^\x21-\x7e]/.test(token)))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['METRICS_QUERY_TOKEN'],
          message:
            mode === 'bearer'
              ? 'METRICS_QUERY_TOKEN must be a nonblank ASCII Bearer token without whitespace or controls'
              : 'METRICS_QUERY_TOKEN must be nonblank without surrounding whitespace or controls',
        });
      }
    }

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
  })
  .transform((environment) => ({
    ...environment,
    METRICS_QUERY_AUTH_MODE: environment.METRICS_QUERY_AUTH_MODE ?? 'basic',
    METRICS_USERNAME:
      (environment.METRICS_QUERY_AUTH_MODE ?? 'basic') === 'basic'
        ? environment.METRICS_USERNAME?.trim()
        : environment.METRICS_USERNAME,
  }));

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
