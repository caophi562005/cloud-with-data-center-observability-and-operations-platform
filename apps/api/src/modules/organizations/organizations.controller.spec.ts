import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationsController } from './organizations.controller.js';

const organization = {
  id: 'org-1',
  name: 'CloudOps',
  slug: 'cloudops',
};

describe('OrganizationsController', () => {
  it('gets an organization through the service', async () => {
    const service = {
      getById: vi.fn().mockResolvedValue(organization),
      update: vi.fn(),
    };
    const controller = new OrganizationsController(
      service as unknown as OrganizationsService,
    );

    await expect(controller.get({ organizationId: 'org-1' })).resolves.toEqual(
      organization,
    );
    expect(service.getById).toHaveBeenCalledWith('org-1');
  });

  it('updates an organization through the service', async () => {
    const service = {
      getById: vi.fn(),
      update: vi.fn().mockResolvedValue({ ...organization, name: 'Updated' }),
    };
    const controller = new OrganizationsController(
      service as unknown as OrganizationsService,
    );

    await expect(
      controller.update({ organizationId: 'org-1' }, { name: 'Updated' }),
    ).resolves.toEqual({ ...organization, name: 'Updated' });
    expect(service.update).toHaveBeenCalledWith('org-1', { name: 'Updated' });
  });

  it('declares exact read and update permissions on tenant handlers', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        OrganizationsController.prototype.get,
      ),
    ).toEqual(['organization.read']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        OrganizationsController.prototype.update,
      ),
    ).toEqual(['organization.update']);
  });
});
