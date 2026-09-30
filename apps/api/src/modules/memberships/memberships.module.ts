import { Module } from '@nestjs/common';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { UsersModule } from '../users/users.module.js';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsRepository } from './memberships.repository.js';
import { MembershipsService } from './memberships.service.js';

@Module({
  imports: [
    AuthorizationModule,
    CognitoModule,
    PrismaModule,
    RedisModule,
    UsersModule,
  ],
  controllers: [MembershipsController],
  providers: [
    MembershipsRepository,
    MembershipsService,
    CognitoAuthGuard,
    PermissionsGuard,
  ],
  exports: [MembershipsService, MembershipsRepository],
})
export class MembershipsModule {}
