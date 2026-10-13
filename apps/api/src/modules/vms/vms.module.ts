import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { UsersModule } from '../users/users.module.js';
import { AgentEnrollmentController } from './agent-enrollment.controller.js';
import { AgentAuthService } from './agent-auth.service.js';
import { AgentAuthGuard } from './agent-auth.guard.js';
import { InstallCodesController } from './install-codes.controller.js';
import { InstallCodesService } from './install-codes.service.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { EnrollmentTokenCacheService } from './enrollment-token-cache.service.js';
import { SecretService } from './secret.service.js';
import { VmsController } from './vms.controller.js';
import { VmsRepository } from './vms.repository.js';
import { VmsService } from './vms.service.js';
import { MetricsModule } from '../../infrastructure/metrics/metrics.module.js';
import { VmMetricsController } from './vm-metrics.controller.js';
import { VmMetricsService } from './vm-metrics.service.js';
import { MonitoringSecretsService } from './monitoring/monitoring-secrets.service.js';
import { MonitoringRepository } from './monitoring/monitoring.repository.js';
import { MonitoringService } from './monitoring/monitoring.service.js';
import { IntegrationObservationService } from './monitoring/integration-observation.service.js';
import { MonitoringController } from './monitoring/monitoring.controller.js';
import { AgentControlController } from './monitoring/agent-control.controller.js';
import { IntegrationMetricsController } from './monitoring/integration-metrics.controller.js';
import { IntegrationMetricsService } from './monitoring/integration-metrics.service.js';

@Module({
  imports: [
    AuthorizationModule,
    CognitoModule,
    PrismaModule,
    RedisModule,
    UsersModule,
    MetricsModule,
  ],
  controllers: [
    VmsController,
    AgentEnrollmentController,
    VmMetricsController,
    InstallCodesController,
    MonitoringController,
    AgentControlController,
    IntegrationMetricsController,
  ],
  providers: [
    VmsRepository,
    EnrollmentRepository,
    EnrollmentTokenCacheService,
    VmsService,
    VmMetricsService,
    AgentEnrollmentService,
    AgentAuthService,
    AgentAuthGuard,
    InstallCodesService,
    SecretService,
    MonitoringSecretsService,
    MonitoringRepository,
    MonitoringService,
    IntegrationObservationService,
    IntegrationMetricsService,
    CognitoAuthGuard,
    PermissionsGuard,
  ],
  exports: [VmsService, VmsRepository, AgentAuthService, AgentAuthGuard],
})
export class VmsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply((_request: Request, response: Response, next: NextFunction) => {
      // Before guards/pipes: even authentication and validation failures on
      // monitoring/control routes must not be cached.
      response.setHeader('Cache-Control', 'no-store');
      next();
    }).forRoutes(MonitoringController, AgentControlController, IntegrationMetricsController);
  }
}
