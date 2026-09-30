export const permissions = [
  'profile.read',
  'organization.read',
  'organization.update',
  'member.read',
  'member.manage',
] as const;

export const PERMISSIONS = permissions;

export type Permission = (typeof permissions)[number];
