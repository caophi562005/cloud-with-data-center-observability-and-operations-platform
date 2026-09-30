import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { authConfig } from '../../config/auth.config.js';
import { CognitoModule } from '../../infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from '../../infrastructure/cache/redis.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthCookieService } from './auth-cookie.service.js';
import { AuthService } from './auth.service.js';
import { CognitoAuthGuard } from './guards/cognito-auth.guard.js';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    CognitoModule,
    RedisModule,
    UsersModule,
    OrganizationsModule,
  ],
  controllers: [AuthController],
  providers: [AuthCookieService, AuthService, CognitoAuthGuard],
  exports: [AuthService, CognitoAuthGuard],
})
export class AuthModule {}
