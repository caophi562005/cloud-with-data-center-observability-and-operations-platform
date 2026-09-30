import { Module } from '@nestjs/common';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { PrismaModule } from '../../infrastructure/database/prisma/prisma.module.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { UsersModule } from '../users/users.module.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsRepository } from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  imports: [
    AuthorizationModule,
    CognitoModule,
    PrismaModule,
    RedisModule,
    UsersModule,
  ],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsRepository,
    OrganizationsService,
    CognitoAuthGuard,
    PermissionsGuard,
  ],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
