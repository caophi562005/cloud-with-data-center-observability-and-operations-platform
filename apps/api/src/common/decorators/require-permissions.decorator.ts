import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../../modules/authorization/permissions.js';

export const PERMISSIONS_KEY = 'required_permissions';
export const REQUIRED_PERMISSIONS_KEY = PERMISSIONS_KEY;

export type PermissionMetadata = Permission;

export const RequirePermissions = (...permissions: PermissionMetadata[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
