import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { MembershipsService } from './memberships.service.js';
import {
  membershipCreateSchema,
  membershipOrganizationParamsSchema,
  membershipParamsSchema,
  membershipRoleSchema,
  type MembershipCreate,
  type MembershipOrganizationParams,
  type MembershipParams,
  type MembershipRoleUpdate,
} from './schemas/membership.schema.js';

@Controller('organizations/:organizationId/members')
@UseGuards(CognitoAuthGuard, PermissionsGuard)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get()
  @RequirePermissions('member.read')
  list(
    @Param(new ZodValidationPipe(membershipOrganizationParamsSchema))
    params: MembershipOrganizationParams,
  ) {
    return this.membershipsService.list(params.organizationId);
  }

  @Post()
  @RequirePermissions('member.manage')
  create(
    @Param(new ZodValidationPipe(membershipOrganizationParamsSchema))
    params: MembershipOrganizationParams,
    @Body(new ZodValidationPipe(membershipCreateSchema))
    input: MembershipCreate,
  ) {
    return this.membershipsService.create(params.organizationId, input);
  }

  @Patch(':userId')
  @RequirePermissions('member.manage')
  updateRole(
    @Param(new ZodValidationPipe(membershipParamsSchema))
    params: MembershipParams,
    @Body(new ZodValidationPipe(membershipRoleSchema))
    input: MembershipRoleUpdate,
  ) {
    return this.membershipsService.updateRole(
      params.organizationId,
      params.userId,
      input.role,
    );
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('member.manage')
  remove(
    @Param(new ZodValidationPipe(membershipParamsSchema))
    params: MembershipParams,
  ): Promise<void> {
    return this.membershipsService.remove(params.organizationId, params.userId);
  }
}
