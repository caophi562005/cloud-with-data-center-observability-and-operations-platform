import { Body, Controller, Get, Header, Param, Patch, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { CognitoAuthGuard } from '../../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../../authorization/guards/permissions.guard.js';
import { vmOrganizationParamsSchema, vmParamsSchema, type VmOrganizationParams, type VmParams } from '../schemas/vm.schema.js';
import { MonitoringService } from './monitoring.service.js';
import type { MonitoringSaveInput } from './monitoring.types.js';

@Controller('organizations/:organizationId')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('monitoring-catalog')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  catalog(@Param(new ZodValidationPipe(vmOrganizationParamsSchema)) _params: VmOrganizationParams) {
    return this.monitoring.getCatalog();
  }

  @Get('vms/:vmId/monitoring-config')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  getConfig(@Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams) {
    return this.monitoring.getHumanConfig(params.organizationId, params.vmId);
  }

  @Patch('vms/:vmId/monitoring-config')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.manage')
  saveConfig(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
    // Service validation uses server VM OS, never a caller-supplied OS/context.
    @Body() input: MonitoringSaveInput,
  ) {
    return this.monitoring.save(params.organizationId, params.vmId, input);
  }

  @Get('vms/:vmId/agent-status')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.read')
  status(@Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams) {
    return this.monitoring.getAgentStatus(params.organizationId, params.vmId);
  }
}
