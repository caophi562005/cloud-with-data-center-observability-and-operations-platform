import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../../common/decorators/require-permissions.decorator.js';
import type { RequestContext } from '../../../common/types/request-context.type.js';
import { AuthorizationService } from '../authorization.service.js';
import { PermissionsGuard } from './permissions.guard.js';
import { UsersService } from '../../users/users.service.js';

function createContext(request: RequestContext): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };
  let usersService: { findByCognitoSub: ReturnType<typeof vi.fn> };
  let authorizationService: { requirePermission: ReturnType<typeof vi.fn> };
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['organization.read']),
    };
    usersService = { findByCognitoSub: vi.fn() };
    authorizationService = { requirePermission: vi.fn() };
    guard = new PermissionsGuard(
      reflector as unknown as Reflector,
      usersService as unknown as UsersService,
      authorizationService as unknown as AuthorizationService,
    );
  });

  it('rejects a request when the principal has no membership in the route organization', async () => {
    usersService.findByCognitoSub.mockResolvedValue({ id: 'user-1' });
    authorizationService.requirePermission.mockRejectedValue(
      new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND' }),
    );
    const request = {
      user: { cognitoSub: 'cognito-sub-1' },
      params: { organizationId: 'org-2' },
    } as unknown as RequestContext;

    await expect(
      guard.canActivate(createContext(request)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(authorizationService.requirePermission).toHaveBeenCalledWith(
      'user-1',
      'org-2',
      'organization.read',
    );
    expect(request.organization).toBeUndefined();
  });

  it('rejects a request when the membership lacks the required permission', async () => {
    usersService.findByCognitoSub.mockResolvedValue({ id: 'user-1' });
    authorizationService.requirePermission.mockRejectedValue(
      new ForbiddenException({ code: 'AUTH_FORBIDDEN' }),
    );
    const request = {
      user: { cognitoSub: 'cognito-sub-1' },
      params: { organizationId: 'org-1' },
    } as unknown as RequestContext;

    await expect(
      guard.canActivate(createContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(request.organization).toBeUndefined();
  });

  it('resolves the local user, authorizes the requested tenant, and attaches membership context', async () => {
    usersService.findByCognitoSub.mockResolvedValue({ id: 'user-1' });
    authorizationService.requirePermission.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.ADMIN,
      permissions: ['organization.read'],
    });
    const request = {
      user: { cognitoSub: 'cognito-sub-1' },
      params: { organizationId: 'org-1' },
    } as unknown as RequestContext;

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      PERMISSIONS_KEY,
      expect.any(Array),
    );
    expect(usersService.findByCognitoSub).toHaveBeenCalledWith('cognito-sub-1');
    expect(request.organization).toEqual({
      id: 'org-1',
      organizationId: 'org-1',
      userId: 'user-1',
      role: Role.ADMIN,
      permissions: ['organization.read'],
    });
  });
});
