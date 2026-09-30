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
      register: vi.fn().mockResolvedValue({
        status: 'CONFIRMATION_REQUIRED',
        email: 'person@example.com',
      }),
      confirmRegistration: vi.fn().mockResolvedValue({ status: 'CONFIRMED' }),
      resendRegistrationCode: vi.fn().mockResolvedValue({
        status: 'CONFIRMATION_REQUIRED',
        email: 'person@example.com',
      }),
      refresh: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
      logout: vi.fn().mockResolvedValue(undefined),
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: 'user-1' }, organizations: [] }),
    };
    const controller = new AuthController(service as unknown as AuthService);
    const loginInput = { email: 'person@example.com', password: 'password' };
    const registerInput = {
      email: 'person@example.com',
      displayName: 'Person',
      password: 'Correct-Horse-123',
      confirmPassword: 'Correct-Horse-123',
    };
    const confirmationInput = {
      email: 'person@example.com',
      confirmationCode: '123456',
    };

    await expect(controller.login(loginInput, response)).resolves.toEqual({
      user: { id: 'user-1' },
    });
    await expect(controller.register(registerInput)).resolves.toEqual({
      status: 'CONFIRMATION_REQUIRED',
      email: 'person@example.com',
    });
    await expect(
      controller.confirmRegistration(confirmationInput),
    ).resolves.toEqual({ status: 'CONFIRMED' });
    await expect(
      controller.resendConfirmationCode({ email: 'person@example.com' }),
    ).resolves.toEqual({
      status: 'CONFIRMATION_REQUIRED',
      email: 'person@example.com',
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
    expect(service.register).toHaveBeenCalledWith({
      email: 'person@example.com',
      displayName: 'Person',
      password: 'Correct-Horse-123',
    });
    expect(service.confirmRegistration).toHaveBeenCalledWith(confirmationInput);
    expect(service.resendRegistrationCode).toHaveBeenCalledWith({
      email: 'person@example.com',
    });
    expect(service.refresh).toHaveBeenCalledWith(request, response);
    expect(service.logout).toHaveBeenCalledWith(request, response);
    expect(service.getCurrentSession).toHaveBeenCalledWith(principal);
  });
});
