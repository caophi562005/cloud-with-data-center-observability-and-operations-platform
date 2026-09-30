import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { HealthCheckService } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import type { DatabaseHealthIndicator } from './indicators/database.health-indicator.js';
import type { RedisHealthIndicator } from './indicators/redis.health-indicator.js';

describe('HealthController', () => {
  it('returns health statuses without provider error details', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'ok',
      info: {
        database: { status: 'up', responseTime: 3, url: 'should-not-leak' },
        redis: { status: 'up', responseTime: 1 },
      },
      error: {},
      details: {
        database: { status: 'up', responseTime: 3, url: 'should-not-leak' },
        redis: { status: 'up', responseTime: 1 },
      },
    });
    const health = { check } as unknown as HealthCheckService;
    const database = {} as DatabaseHealthIndicator;
    const redis = {} as RedisHealthIndicator;
    const controller = new HealthController(health, database, redis);

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      info: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
      error: {},
      details: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
    });

    const [indicators] = check.mock.calls[0] as [Array<() => unknown>];
    expect(indicators).toHaveLength(2);
  });

  it('sanitizes unexpected health failures', async () => {
    const check = vi
      .fn()
      .mockRejectedValue(new Error('DATABASE_URL=secret-value'));
    const health = { check } as unknown as HealthCheckService;
    const controller = new HealthController(
      health,
      {} as DatabaseHealthIndicator,
      {} as RedisHealthIndicator,
    );

    await expect(controller.check()).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ServiceUnavailableException)) {
        return false;
      }
      return !JSON.stringify(error.getResponse()).includes('secret-value');
    });
  });
});
