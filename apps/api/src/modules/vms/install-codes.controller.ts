import {
  Controller,
  Delete,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { InstallCodesService } from './install-codes.service.js';
import { installCodeParamsSchema } from './schemas/enrollment.schema.js';
import {
  vmOrganizationParamsSchema,
  type VmOrganizationParams,
} from './schemas/vm.schema.js';

@Controller('organizations/:organizationId/agent-install-codes')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class InstallCodesController {
  constructor(private readonly installCodesService: InstallCodesService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('vm.enroll')
  issue(
    @Param(new ZodValidationPipe(vmOrganizationParamsSchema))
    params: VmOrganizationParams,
  ) {
    return this.installCodesService.issue(params.organizationId);
  }

  @Delete(':tokenId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vm.enroll')
  revoke(
    @Param(new ZodValidationPipe(installCodeParamsSchema))
    params: {
      organizationId: string;
      tokenId: string;
    },
  ): Promise<void> {
    return this.installCodesService.revoke(
      params.organizationId,
      params.tokenId,
    );
  }
}
