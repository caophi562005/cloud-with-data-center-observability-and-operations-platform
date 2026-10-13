import type { Role } from '@prisma/client';
import type { Permission } from './permissions.js';

export const rolePermissions: Record<Role, readonly Permission[]> = {
  ADMIN: [
    'profile.read',
    'organization.read',
    'organization.update',
    'member.read',
    'member.manage',
    'vm.read',
    'vm.manage',
    'vm.enroll',
    'vm.agent.revoke',
    'alert.read',
    'alert.manage',
  ],
  OPERATOR: [
    'profile.read',
    'organization.read',
    'member.read',
    'vm.read',
    'vm.manage',
    'vm.enroll',
    'vm.agent.revoke',
    'alert.read',
    'alert.manage',
  ],
  VIEWER: [
    'profile.read',
    'organization.read',
    'member.read',
    'vm.read',
    'alert.read',
  ],
};
