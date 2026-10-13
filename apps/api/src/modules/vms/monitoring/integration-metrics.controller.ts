import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { CognitoAuthGuard } from '../../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../../authorization/guards/permissions.guard.js';
import {
  integrationMetricsCurrentSchema, integrationMetricsParamsSchema, integrationMetricsRangeSchema,
  type IntegrationMetricsParams, type IntegrationMetricsRangeInput,
} from './integration-metrics.schema.js';
import { IntegrationMetricsService } from './integration-metrics.service.js';

@Controller('organizations/:organizationId/vms/:vmId/integrations/:instanceId/metrics')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class IntegrationMetricsController {
  constructor(private readonly metrics: IntegrationMetricsService) {}

  @Get('current')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  current(@Param(new ZodValidationPipe(integrationMetricsParamsSchema)) params: IntegrationMetricsParams,
    @Query(new ZodValidationPipe(integrationMetricsCurrentSchema)) _query: Record<string, never>) {
    return this.metrics.getCurrent(params.organizationId, params.vmId, params.instanceId);
  }

  @Get('range')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  range(@Param(new ZodValidationPipe(integrationMetricsParamsSchema)) params: IntegrationMetricsParams,
    @Query(new ZodValidationPipe(integrationMetricsRangeSchema)) query: IntegrationMetricsRangeInput) {
    return this.metrics.getRange(params.organizationId, params.vmId, params.instanceId, query);
  }
}
