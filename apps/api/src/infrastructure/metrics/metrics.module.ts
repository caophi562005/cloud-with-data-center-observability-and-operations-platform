import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { metricsConfig } from '../../config/metrics.config.js';
import { MetricsQueryClient } from './metrics-query.client.js';
@Module({
  imports: [ConfigModule.forFeature(metricsConfig)],
  providers: [MetricsQueryClient],
  exports: [MetricsQueryClient, ConfigModule],
})
export class MetricsModule {}
