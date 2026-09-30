import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { OrganizationsService } from './organizations.service.js';
import {
  organizationParamsSchema,
  organizationUpdateSchema,
  type OrganizationParams,
  type OrganizationUpdate,
} from './schemas/organization.schema.js';

@Controller('organizations')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get(':organizationId')
  @RequirePermissions('organization.read')
  get(
    @Param(new ZodValidationPipe(organizationParamsSchema))
    params: OrganizationParams,
  ) {
    return this.organizationsService.getById(params.organizationId);
  }

  @Patch(':organizationId')
  @RequirePermissions('organization.update')
  update(
    @Param(new ZodValidationPipe(organizationParamsSchema))
    params: OrganizationParams,
    @Body(new ZodValidationPipe(organizationUpdateSchema))
    input: OrganizationUpdate,
  ) {
    return this.organizationsService.update(params.organizationId, input);
  }
}
