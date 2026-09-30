import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RequestIdInterceptor } from './request-id.interceptor.js';

function contextFor(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('RequestIdInterceptor', () => {
  it('preserves a valid incoming request id and echoes it in the response', () => {
    const request = { headers: { 'x-request-id': 'request-123' } } as Record<
      string,
      unknown
    >;
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Record<string, unknown>;
    const handled = of('handled');
    const handle = vi.fn(() => handled);
    const next: CallHandler = { handle };

    const result = new RequestIdInterceptor().intercept(
      contextFor(request, response),
      next,
    );

    expect(result).toBe(handled);
    expect(request.requestId).toBe('request-123');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'request-123');
    expect(handle).toHaveBeenCalledOnce();
  });

  it('generates and attaches a request id when the client did not send one', () => {
    const request = { headers: {} } as Record<string, unknown>;
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Record<string, unknown>;
    const handled = of('handled');
    const handle = vi.fn(() => handled);
    const next: CallHandler = { handle };

    new RequestIdInterceptor().intercept(contextFor(request, response), next);

    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(setHeader).toHaveBeenCalledWith('x-request-id', request.requestId);
  });
});
