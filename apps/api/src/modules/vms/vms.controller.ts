import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import {
  vmCreateSchema,
  vmListQuerySchema,
  vmOrganizationParamsSchema,
  vmParamsSchema,
  vmTagParamsSchema,
  vmTagSchema,
  vmUpdateSchema,
  type VmCreateInput,
  type VmListQuery,
  type VmOrganizationParams,
  type VmParams,
  type VmTagInput,
  type VmTagParams,
  type VmUpdateInput,
} from './schemas/vm.schema.js';
import { VmsService } from './vms.service.js';

@Controller('organizations/:organizationId/vms')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class VmsController {
  constructor(private readonly vmsService: VmsService) {}

  @Get()
  @RequirePermissions('vm.read')
  list(
    @Param(new ZodValidationPipe(vmOrganizationParamsSchema))
    params: VmOrganizationParams,
    @Query(new ZodValidationPipe(vmListQuerySchema)) query: VmListQuery,
  ) {
    return this.vmsService.list(params.organizationId, {
      page: query.page,
      pageSize: query.pageSize,
      tags: toTagFilters(query.tag),
    });
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.manage')
  create(
    @Param(new ZodValidationPipe(vmOrganizationParamsSchema))
    params: VmOrganizationParams,
    @Body(new ZodValidationPipe(vmCreateSchema)) input: VmCreateInput,
  ) {
    return this.vmsService.create(params.organizationId, input);
  }

  @Get(':vmId')
  @RequirePermissions('vm.read')
  get(@Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams) {
    return this.vmsService.get(params.organizationId, params.vmId);
  }

  @Patch(':vmId')
  @RequirePermissions('vm.manage')
  update(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
    @Body(new ZodValidationPipe(vmUpdateSchema)) input: VmUpdateInput,
  ) {
    return this.vmsService.update(params.organizationId, params.vmId, input);
  }

  @Delete(':vmId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vm.manage')
  remove(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
  ): Promise<void> {
    return this.vmsService.remove(params.organizationId, params.vmId);
  }

  @Post(':vmId/enrollment-token')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.enroll')
  reissueEnrollmentToken(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
  ) {
    return this.vmsService.reissueEnrollmentToken(
      params.organizationId,
      params.vmId,
    );
  }

  @Post(':vmId/agent/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vm.agent.revoke')
  revokeAgent(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
  ): Promise<void> {
    return this.vmsService.revokeAgent(params.organizationId, params.vmId);
  }

  @Post(':vmId/tags')
  @RequirePermissions('vm.manage')
  addTag(
    @Param(new ZodValidationPipe(vmParamsSchema)) params: VmParams,
    @Body(new ZodValidationPipe(vmTagSchema)) input: VmTagInput,
  ) {
    return this.vmsService.addTag(params.organizationId, params.vmId, input);
  }

  @Patch(':vmId/tags/:tagId')
  @RequirePermissions('vm.manage')
  updateTag(
    @Param(new ZodValidationPipe(vmTagParamsSchema)) params: VmTagParams,
    @Body(new ZodValidationPipe(vmTagSchema)) input: VmTagInput,
  ) {
    return this.vmsService.updateTag(
      params.organizationId,
      params.vmId,
      params.tagId,
      input,
    );
  }

  @Delete(':vmId/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vm.manage')
  removeTag(
    @Param(new ZodValidationPipe(vmTagParamsSchema)) params: VmTagParams,
  ): Promise<void> {
    return this.vmsService.removeTag(
      params.organizationId,
      params.vmId,
      params.tagId,
    );
  }
}

function toTagFilters(tags: string[] | undefined) {
  return (tags ?? []).map((tag) => {
    const separatorIndex = tag.indexOf(':');
    return {
      key: tag.slice(0, separatorIndex),
      value: tag.slice(separatorIndex + 1),
    };
  });
}
