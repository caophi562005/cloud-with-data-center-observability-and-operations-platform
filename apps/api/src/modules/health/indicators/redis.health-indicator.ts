import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { RedisService } from '../../../infrastructure/cache/redis.service.js';

@Injectable()
export class RedisHealthIndicator {
  constructor(private readonly redis: RedisService) {}

  async isHealthy(): Promise<HealthIndicatorResult<'redis'>> {
    try {
      const healthy = await this.redis.ping();
      return { redis: { status: healthy ? 'up' : 'down' } };
    } catch {
      return { redis: { status: 'down' } };
    }
  }
}
