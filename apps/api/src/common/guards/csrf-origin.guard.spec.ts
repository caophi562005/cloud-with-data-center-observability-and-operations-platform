import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CsrfOriginGuard } from './csrf-origin.guard.js';

type RequestLike = {
  method: string;
  headers: Record<string, string | undefined>;
};

function contextFor(request: RequestLike): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function configFor(nodeEnv: 'development' | 'production') {
  return {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'app.webUrl') return 'http://localhost:5173';
      throw new Error(`Unexpected config key: ${key}`);
    }),
  } as unknown as ConfigService;
}

describe('CsrfOriginGuard', () => {
  it('rejects unsafe production requests from a different origin', () => {
    const guard = new CsrfOriginGuard(configFor('production'));
    const request = {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    };

    expect(() => guard.canActivate(contextFor(request))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects unsafe production requests without origin or referer', () => {
    const guard = new CsrfOriginGuard(configFor('production'));
    const request = { method: 'PATCH', headers: {} };

    expect(() => guard.canActivate(contextFor(request))).toThrow(
      ForbiddenException,
    );
  });

  it('allows the configured localhost origin during development', () => {
    const guard = new CsrfOriginGuard(configFor('development'));
    const request = {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    };

    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it('does not require an origin for safe requests', () => {
    const guard = new CsrfOriginGuard(configFor('production'));
    const request = { method: 'GET', headers: {} };

    expect(guard.canActivate(contextFor(request))).toBe(true);
  });
});
