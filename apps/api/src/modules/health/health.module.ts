import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { HealthController } from './health.controller.js';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator.js';
import { RedisHealthIndicator } from './indicators/redis.health-indicator.js';

@Module({
  imports: [TerminusModule, PrismaModule, RedisModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
