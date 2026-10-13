import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AlertService } from './alert.service.js';
import {
  alertOrganizationParamsSchema,
  alertParamsSchema,
  alertListQuerySchema,
  alertEventsQuerySchema,
  alertAcknowledgeSchema,
  alertCommentSchema,
  type AlertListQuery,
  type AlertEventsQuery,
  type AlertCommentInput,
} from './schemas/alert-operations.schema.js';

// Parameter pipes run after guards: validate the tenant selector before any membership DB lookup.
@Injectable()
export class AlertOrganizationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    new ZodValidationPipe(alertOrganizationParamsSchema).transform({
      organizationId: request.params.organizationId,
    });
    return true;
  }
}

@Controller('organizations/:organizationId/alerts')
@UseGuards(CognitoAuthGuard, AlertOrganizationGuard, PermissionsGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.read')
  list(
    @Param(new ZodValidationPipe(alertOrganizationParamsSchema))
    params: { organizationId: string },
    @Query(new ZodValidationPipe(alertListQuerySchema)) query: AlertListQuery,
  ) {
    return this.alerts.list(params.organizationId, query);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.read')
  get(
    @Param(new ZodValidationPipe(alertParamsSchema))
    params: {
      organizationId: string;
      id: string;
    },
  ) {
    return this.alerts.get(params.organizationId, params.id);
  }
  @Get(':id/events')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.read')
  events(
    @Param(new ZodValidationPipe(alertParamsSchema))
    params: { organizationId: string; id: string },
    @Query(new ZodValidationPipe(alertEventsQuerySchema))
    query: AlertEventsQuery,
  ) {
    return this.alerts.events(params.organizationId, params.id, query);
  }
  @Post(':id/acknowledge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.manage')
  acknowledge(
    @Param(new ZodValidationPipe(alertParamsSchema))
    params: { organizationId: string; id: string },
    @CurrentOrganization('userId') actor: string,
    @Body(new ZodValidationPipe(alertAcknowledgeSchema)) _input: unknown,
  ) {
    return this.alerts.acknowledge(params.organizationId, params.id, actor);
  }
  @Post(':id/comments')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.manage')
  comment(
    @Param(new ZodValidationPipe(alertParamsSchema))
    params: { organizationId: string; id: string },
    @CurrentOrganization('userId') actor: string,
    @Body(new ZodValidationPipe(alertCommentSchema)) input: AlertCommentInput,
  ) {
    return this.alerts.comment(params.organizationId, params.id, actor, input);
  }
}
