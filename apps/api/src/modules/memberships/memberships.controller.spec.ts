import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator.js';
import { MembershipsService } from './memberships.service.js';
import { MembershipsController } from './memberships.controller.js';

const member = {
  id: 'membership-1',
  userId: 'user-1',
  email: 'person@example.com',
  displayName: 'Person',
  role: Role.VIEWER,
};

describe('MembershipsController', () => {
  it('lists members through the service', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([member]),
      create: vi.fn(),
      updateRole: vi.fn(),
      remove: vi.fn(),
    };
    const controller = new MembershipsController(
      service as unknown as MembershipsService,
    );

    await expect(controller.list({ organizationId: 'org-1' })).resolves.toEqual(
      [member],
    );
    expect(service.list).toHaveBeenCalledWith('org-1');
  });

  it('creates a membership for an already synchronized local user', async () => {
    const service = {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue(member),
      updateRole: vi.fn(),
      remove: vi.fn(),
    };
    const controller = new MembershipsController(
      service as unknown as MembershipsService,
    );

    await expect(
      controller.create(
        { organizationId: 'org-1' },
        { userId: 'user-1', role: Role.VIEWER },
      ),
    ).resolves.toEqual(member);
    expect(service.create).toHaveBeenCalledWith('org-1', {
      userId: 'user-1',
      role: Role.VIEWER,
    });
  });

  it('updates a member role and deletes a member through the service', async () => {
    const service = {
      list: vi.fn(),
      create: vi.fn(),
      updateRole: vi.fn().mockResolvedValue({ ...member, role: Role.OPERATOR }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new MembershipsController(
      service as unknown as MembershipsService,
    );

    await expect(
      controller.updateRole(
        { organizationId: 'org-1', userId: 'user-1' },
        { role: Role.OPERATOR },
      ),
    ).resolves.toMatchObject({ role: Role.OPERATOR });
    await expect(
      controller.remove({ organizationId: 'org-1', userId: 'user-1' }),
    ).resolves.toBeUndefined();
    expect(service.updateRole).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      Role.OPERATOR,
    );
    expect(service.remove).toHaveBeenCalledWith('org-1', 'user-1');
  });

  it('declares exact member permissions on handlers', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        MembershipsController.prototype.list,
      ),
    ).toEqual(['member.read']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        MembershipsController.prototype.create,
      ),
    ).toEqual(['member.manage']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        MembershipsController.prototype.updateRole,
      ),
    ).toEqual(['member.manage']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        MembershipsController.prototype.remove,
      ),
    ).toEqual(['member.manage']);
  });
});
