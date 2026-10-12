import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { alertOrganizationParamsSchema } from './schemas/alert-operations.schema.js';
import { AlertOrganizationGuard } from './alerts.controller.js';
import { AlertRulesService } from './alert-rules.service.js';
@Controller('organizations/:organizationId/alert-rules')
@UseGuards(CognitoAuthGuard, AlertOrganizationGuard, PermissionsGuard)
export class AlertRulesController {
  constructor(private readonly rules: AlertRulesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('alert.read')
  list(
    @Param(new ZodValidationPipe(alertOrganizationParamsSchema))
    params: { organizationId: string },
    @Query(new ZodValidationPipe(z.object({}).strict()))
    _query: Record<string, never>,
  ) {
    return this.rules.list(params.organizationId);
  }
}
