import { Module } from '@nestjs/common';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { UsersModule } from '../users/users.module.js';
import { AgentEnrollmentController } from './agent-enrollment.controller.js';
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

@Module({
  imports: [
    AuthorizationModule,
    CognitoModule,
    PrismaModule,
    RedisModule,
    UsersModule,
    MetricsModule,
  ],
  controllers: [VmsController, AgentEnrollmentController, VmMetricsController],
  providers: [
    VmsRepository,
    EnrollmentRepository,
    EnrollmentTokenCacheService,
    VmsService,
    VmMetricsService,
    AgentEnrollmentService,
    SecretService,
    CognitoAuthGuard,
    PermissionsGuard,
  ],
  exports: [VmsService, VmsRepository],
})
export class VmsModule {}
