import { Module } from '@nestjs/common';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { UsersModule } from '../users/users.module.js';
import { MembershipsRepository } from '../memberships/memberships.repository.js';
import { AuthorizationService } from './authorization.service.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';

@Module({
  imports: [CognitoModule, PrismaModule, RedisModule, UsersModule],
  providers: [
    MembershipsRepository,
    AuthorizationService,
    CognitoAuthGuard,
    PermissionsGuard,
  ],
  exports: [AuthorizationService, CognitoAuthGuard, PermissionsGuard],
})
export class AuthorizationModule {}
