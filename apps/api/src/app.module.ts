import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CsrfOriginGuard } from './common/guards/csrf-origin.guard.js';
import { loggerRedactionPaths } from './common/logging/logger-redaction.js';
import {
  appConfig,
  authConfig,
  databaseConfig,
  parseEnv,
  redisConfig,
} from './config/index.js';
import { CognitoModule } from './infrastructure/aws/cognito/cognito.module.js';
import { RedisModule } from './infrastructure/cache/redis.module.js';
import { PrismaModule } from './infrastructure/database/prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthorizationModule } from './modules/authorization/authorization.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MembershipsModule } from './modules/memberships/memberships.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { UsersModule } from './modules/users/users.module.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT = 10;
const GENERAL_RATE_LIMIT = 120;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: parseEnv,
      load: [appConfig, authConfig, databaseConfig, redisConfig],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.getOrThrow<string>('app.nodeEnv') === 'production';

        return {
          pinoHttp: {
            level: isProduction ? 'info' : 'silent',
            autoLogging: isProduction,
            redact: {
              paths: [...loggerRedactionPaths],
              censor: '[REDACTED]',
            },
          },
        };
      },
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'auth',
          ttl: RATE_LIMIT_WINDOW_MS,
          limit: AUTH_RATE_LIMIT,
          skipIf: (context) => !isAuthRateLimitedRoute(context),
        },
        {
          name: 'general',
          ttl: RATE_LIMIT_WINDOW_MS,
          limit: GENERAL_RATE_LIMIT,
          skipIf: (context) => isAuthRateLimitedRoute(context),
        },
      ],
    }),
    PrismaModule,
    RedisModule,
    CognitoModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    MembershipsModule,
    AuthorizationModule,
    HealthModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CsrfOriginGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

export function isAuthRateLimitedRoute(context: {
  switchToHttp(): {
    getRequest(): {
      path?: string;
      originalUrl?: string;
      route?: { path?: string };
    };
  };
}): boolean {
  const request = context.switchToHttp().getRequest();
  const route =
    request.path ?? request.route?.path ?? request.originalUrl ?? '';
  return /\/auth\/(?:login|refresh)\/?(?:\?.*)?$/.test(route);
}

export const throttling = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  authLimit: AUTH_RATE_LIMIT,
  generalLimit: GENERAL_RATE_LIMIT,
} as const;

export { loggerRedactionPaths };
