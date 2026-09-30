import { describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../../infrastructure/cache/redis.service.js';
import { RedisHealthIndicator } from './redis.health-indicator.js';

describe('RedisHealthIndicator', () => {
  it('reports an up status after Redis responds to ping', async () => {
    const redis = { ping: vi.fn().mockResolvedValue(true) };
    const indicator = new RedisHealthIndicator(
      redis as unknown as RedisService,
    );

    await expect(indicator.isHealthy()).resolves.toEqual({
      redis: { status: 'up' },
    });
    expect(redis.ping).toHaveBeenCalledOnce();
  });

  it('reports only down status metadata when Redis is unavailable', async () => {
    const redis = { ping: vi.fn().mockResolvedValue(false) };
    const indicator = new RedisHealthIndicator(
      redis as unknown as RedisService,
    );

    await expect(indicator.isHealthy()).resolves.toEqual({
      redis: { status: 'down' },
    });
  });
});
