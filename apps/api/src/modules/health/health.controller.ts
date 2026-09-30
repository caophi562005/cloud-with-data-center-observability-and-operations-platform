import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator.js';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator.js';
import { RedisHealthIndicator } from './indicators/redis.health-indicator.js';

const HEALTH_STATUSES = new Set(['up', 'down', 'degraded']);
type HealthStatus = 'up' | 'down' | 'degraded';
type SafeHealthDetails = Record<string, { status: HealthStatus }>;

export type SafeHealthCheckResult = {
  status: HealthCheckResult['status'];
  info: SafeHealthDetails;
  error: SafeHealthDetails;
  details: SafeHealthDetails;
};

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  async check(): Promise<SafeHealthCheckResult> {
    try {
      const result = await this.health.check([
        () => this.database.isHealthy(),
        () => this.redis.isHealthy(),
      ]);
      return sanitizeHealthResult(result);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException(
          sanitizeHealthResult(error.getResponse()),
        );
      }
      throw new ServiceUnavailableException(sanitizeHealthResult(undefined));
    }
  }
}

function sanitizeHealthResult(value: unknown): SafeHealthCheckResult {
  const source = unwrapHealthResult(value);
  const status = isHealthCheckStatus(source.status) ? source.status : 'error';

  return {
    status,
    info: sanitizeDetails(source.info),
    error: sanitizeDetails(source.error),
    details: sanitizeDetails(source.details),
  };
}

function unwrapHealthResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  if (isRecord(value.message)) {
    return value.message;
  }

  return value;
}

function sanitizeDetails(value: unknown): SafeHealthDetails {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, detail]) => {
      if (!isRecord(detail) || !isHealthStatus(detail.status)) {
        return [];
      }
      return [[key, { status: detail.status }]];
    }),
  );
}

function isHealthStatus(value: unknown): value is HealthStatus {
  return typeof value === 'string' && HEALTH_STATUSES.has(value);
}

function isHealthCheckStatus(
  value: unknown,
): value is HealthCheckResult['status'] {
  return (
    value === 'ok' ||
    value === 'error' ||
    value === 'degraded' ||
    value === 'shutting_down'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
