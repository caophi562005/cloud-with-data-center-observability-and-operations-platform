import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { vmParamsSchema, type VmParams } from './schemas/vm.schema.js';
import {
  vmMetricsQuerySchema,
  type VmMetricsQuery,
} from './schemas/vm-metrics.schema.js';
import { VmMetricsService } from './vm-metrics.service.js';
@Controller('organizations/:organizationId/vms/:vmId/metrics')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class VmMetricsController {
  constructor(private readonly telemetry: VmMetricsService) {}
  @Get('current')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  current(@Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams) {
    return this.telemetry.current(params.organizationId, params.vmId);
  }
  @Get('range')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  range(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
    @Query(new ZodValidationPipe(vmMetricsQuerySchema)) query: VmMetricsQuery,
  ) {
    return this.telemetry.range(params.organizationId, params.vmId, query);
  }
}
