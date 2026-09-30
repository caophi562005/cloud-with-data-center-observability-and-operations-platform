import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';

const response = {} as Response;
const request = { cookies: {} } as unknown as Request;
const principal: AuthenticatedUser = {
  cognitoSub: 'cognito-sub-1',
  clientId: 'client-id',
  tokenUse: 'access',
};

describe('AuthController', () => {
  it('delegates login, refresh, logout, and me to AuthService', async () => {
    const service = {
      login: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
      refresh: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
      logout: vi.fn().mockResolvedValue(undefined),
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: 'user-1' }, organizations: [] }),
    };
    const controller = new AuthController(service as unknown as AuthService);
    const loginInput = { email: 'person@example.com', password: 'password' };

    await expect(controller.login(loginInput, response)).resolves.toEqual({
      user: { id: 'user-1' },
    });
    await expect(controller.refresh(request, response)).resolves.toEqual({
      user: { id: 'user-1' },
    });
    await expect(controller.logout(request, response)).resolves.toBeUndefined();
    await expect(controller.me(principal)).resolves.toEqual({
      user: { id: 'user-1' },
      organizations: [],
    });

    expect(service.login).toHaveBeenCalledWith(loginInput, response);
    expect(service.refresh).toHaveBeenCalledWith(request, response);
    expect(service.logout).toHaveBeenCalledWith(request, response);
    expect(service.getCurrentSession).toHaveBeenCalledWith(principal);
  });
});
