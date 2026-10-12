export const permissions = [
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
] as const;

export type Permission = (typeof permissions)[number];
