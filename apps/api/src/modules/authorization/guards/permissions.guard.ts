import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/require-permissions.decorator.js';
import type { RequestContext } from '../../../common/types/request-context.type.js';
import { UsersService } from '../../users/users.service.js';
import type { Permission } from '../permissions.js';
import { AuthorizationService } from '../authorization.service.js';

const AUTH_UNAUTHORIZED_RESPONSE = {
  code: 'AUTH_UNAUTHORIZED',
  message: 'Authentication required',
} as const;

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestContext>();
    const principal = request.user;
    if (!principal?.cognitoSub) {
      throw unauthorized();
    }

    const organizationId = request.params?.organizationId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Organization is required',
      });
    }

    const user = await this.usersService.findByCognitoSub(principal.cognitoSub);
    if (!user) {
      throw unauthorized();
    }

    let membership = null;
    for (const permission of requiredPermissions) {
      membership = await this.authorizationService.requirePermission(
        user.id,
        organizationId,
        permission,
      );
    }

    if (!membership) {
      throw unauthorized();
    }

    request.organization = {
      id: membership.organizationId,
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
      permissions: [...membership.permissions],
    };
    return true;
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException(AUTH_UNAUTHORIZED_RESPONSE);
}
