import { Module } from '@nestjs/common';
import { MetricsModule } from '../../infrastructure/metrics/metrics.module.js';
import { AlertRulesController } from './alert-rules.controller.js';
import { AlertRulesService } from './alert-rules.service.js';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { UsersModule } from '../users/users.module.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import {
  AlertOrganizationGuard,
  AlertsController,
} from './alerts.controller.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { AlertRepository } from './alert.repository.js';
import { AlertService } from './alert.service.js';
import { SnsAlertsController } from './sns/sns-alerts.controller.js';
import { SnsCertificateProvider } from './sns/sns-certificate.provider.js';
import { SnsConfirmationService } from './sns/sns-confirmation.service.js';
import { SnsMessageVerifier } from './sns/sns-message.verifier.js';

@Module({
  imports: [
    PrismaModule,
    MetricsModule,
    AuthorizationModule,
    CognitoModule,
    RedisModule,
    UsersModule,
  ],
  controllers: [SnsAlertsController, AlertsController, AlertRulesController],
  providers: [
    AlertRepository,
    AlertService,
    AlertRulesService,
    SnsCertificateProvider,
    SnsConfirmationService,
    SnsMessageVerifier,
    CognitoAuthGuard,
    AlertOrganizationGuard,
    PermissionsGuard,
  ],
})
export class AlertsModule {}
