import type { Role } from '@prisma/client';
import type { Permission } from './permissions.js';

export const rolePermissions: Record<Role, readonly Permission[]> = {
  ADMIN: [
    'profile.read',
    'organization.read',
    'organization.update',
    'member.read',
    'member.manage',
  ],
  OPERATOR: ['profile.read', 'organization.read', 'member.read'],
  VIEWER: ['profile.read', 'organization.read', 'member.read'],
};
