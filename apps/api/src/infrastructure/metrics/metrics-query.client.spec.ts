import { createServer } from 'node:http';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MetricsQueryClient,
  metricsUnavailable,
} from './metrics-query.client.js';

const publicFailure = {
  code: 'METRICS_UNAVAILABLE',
  message: 'Metrics are temporarily unavailable',
};
async function failure(pending: Promise<unknown>) {
  const error: unknown = await pending.then(
    () => {
      throw new Error('Expected metrics request to fail');
    },
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  const exception = error as ServiceUnavailableException;
  expect(exception.getStatus()).toBe(503);
  expect(exception.getResponse()).toEqual(publicFailure);
  expect(exception.cause).toBeUndefined();
  return exception;
}

const settings = {
  query: {
    baseUrl: 'https://metrics.example/api/prom',
    auth: {
      mode: 'basic' as const,
      username: 'tenant',
      token: 'synthetic-read-token',
    },
  },
};
const vector = (value = '0') => ({
  status: 'success',
  data: {
    resultType: 'vector',
    result: [{ metric: { vm_id: 'vm' }, value: [100, value] }],
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('MetricsQueryClient', () => {
  it('reads only the shared alert namespace/group with correct filters', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: 'success',
        data: { groups: [{ name: 'actual-group' }] },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await new MetricsQueryClient(settings).listRuleGroups()).toEqual([
      { name: 'actual-group' },
    ]);
    const url = fetcher.mock.calls[0]?.[0];
    if (!(url instanceof URL)) throw new Error('Expected a URL request');
    expect(url.pathname).toBe('/api/prom/api/v1/rules');
    expect(url.searchParams.get('type')).toBe('alert');
    expect(url.searchParams.get('file[]')).toBe('opsgrid-dev-vm-alerts');
    expect(url.searchParams.get('rule_group[]')).toBe('opsgrid-vm-health');
    expect(url.searchParams.get('group_limit')).toBe('100');
  });
  it('follows group pagination without losing namespace filters', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: 'success',
          data: { groups: [{ name: 'first' }], groupNextToken: 'token+/?' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: 'success',
          data: { groups: [{ name: 'second' }] },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await new MetricsQueryClient(settings).listRuleGroups()).toEqual([
      { name: 'first' },
      { name: 'second' },
    ]);
    const url = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(url.searchParams.get('group_next_token')).toBe('token+/?');
    expect(url.searchParams.get('file[]')).toBe('opsgrid-dev-vm-alerts');
  });
  it('rejects repeated pagination tokens rather than looping or returning partial rules', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status: 'success',
          data: { groups: [], groupNextToken: 'same' },
        }),
      ),
    );
    await failure(new MetricsQueryClient(settings).listRuleGroups());
  });
  it('accepts exactly 100 groups over five pages', async () => {
    let page = 0;
    const fetcher = vi.fn(async () =>
      Response.json({
        status: 'success',
        data: {
          groups: Array.from({ length: 20 }, () => ({ name: 'group' })),
          ...(++page < 5 ? { groupNextToken: `page-${page}` } : {}),
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await new MetricsQueryClient(settings).listRuleGroups(),
    ).toHaveLength(100);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('rejects cumulative group overflow rather than returning partial rules', async () => {
    let page = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status: 'success',
          data: {
            groups: Array.from({ length: ++page === 1 ? 100 : 1 }, () => ({
              name: 'group',
            })),
            ...(page === 1 ? { groupNextToken: 'second' } : {}),
          },
        }),
      ),
    );
    await failure(new MetricsQueryClient(settings).listRuleGroups());
  });
  it('rejects pagination requiring a sixth page without making that request', async () => {
    let page = 0;
    const fetcher = vi.fn(async () =>
      Response.json({
        status: 'success',
        data: { groups: [], groupNextToken: `page-${++page}` },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await failure(new MetricsQueryClient(settings).listRuleGroups());
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('rejects invalid rule envelopes with sanitized failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ status: 'error', error: 'private-provider-error' }),
      ),
    );
    await failure(new MetricsQueryClient(settings).listRuleGroups());
  });
  it('keeps internal failure reason out of public response', () => {
    const error = metricsUnavailable('timeout');
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.constructor.name).toBe('MetricsUnavailableException');
    expect(error).toMatchObject({ reason: 'timeout' });
    expect(error.getResponse()).toEqual(publicFailure);
    expect(error.getStatus()).toBe(503);
    expect(metricsUnavailable()).toMatchObject({ reason: 'invalid_response' });
    expect(metricsUnavailable().getResponse()).toEqual(publicFailure);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [400, 'client_error'],
    [422, 'client_error'],
    [429, 'client_error'],
    [500, 'server_error'],
    [503, 'server_error'],
    [301, 'redirect'],
    [302, 'redirect'],
    [307, 'redirect'],
    [308, 'redirect'],
  ])(
    'sanitizes transport and HTTP failure classes: %s → %s',
    async (status, reason) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              'Authorization synthetic-read-token https://provider.example raw-provider-body',
              { status },
            ),
          ),
      );
      expect(
        await failure(new MetricsQueryClient(settings).query('secret-promql')),
      ).toMatchObject({ reason });
    },
  );

  it('classifies explicit redirected responses without reading the body', async () => {
    const response = Response.json(vector());
    Object.defineProperty(response, 'redirected', { value: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(
      await failure(new MetricsQueryClient(settings).query('x')),
    ).toMatchObject({ reason: 'redirect' });
    expect(response.bodyUsed).toBe(false);
  });

  it('classifies rejected fetch as network without interpreting raw messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            'timeout redirect unauthorized synthetic-read-token https://provider.example',
          ),
        ),
    );
    expect(
      await failure(new MetricsQueryClient(settings).query('x')),
    ).toMatchObject({ reason: 'network' });
  });

  it('preserves an already classified exception rather than replacing it in catch', async () => {
    const classified = metricsUnavailable('server_error');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(classified));
    expect(await failure(new MetricsQueryClient(settings).query('x'))).toBe(
      classified,
    );
  });

  it('rejects native redirects without reaching the controlled loopback destination', async () => {
    const reached: string[] = [];
    const server = createServer((req, res) => {
      reached.push(req.url ?? '');
      if (req.url?.startsWith('/api/v1/query?')) {
        res.writeHead(302, { Location: '/destination' });
        res.end('synthetic-provider-body');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vector()));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing loopback port');
      const client = new MetricsQueryClient({
        query: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          auth: { mode: 'none' },
        },
      });
      const error = await failure(client.query('x'));
      expect(reached).toEqual(['/api/v1/query?query=x']);
      expect(error).toMatchObject({ reason: 'network' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ['malformed JSON', () => new Response('{bad synthetic-read-token')],
    [
      'provider error schema',
      () => Response.json({ status: 'error', error: 'synthetic-read-token' }),
    ],
    [
      'wrong result type',
      () =>
        Response.json({
          status: 'success',
          data: { resultType: 'matrix', result: [] },
        }),
    ],
    ['missing body', () => new Response(null)],
    [
      'advertised oversized length',
      () => new Response('{}', { headers: { 'Content-Length': '2000001' } }),
    ],
  ])('classifies %s as invalid_response', async (_name, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    expect(
      await failure(new MetricsQueryClient(settings).query('x')),
    ).toMatchObject({ reason: 'invalid_response' });
  });

  it('caps streaming bytes above 2,000,000 and cancels the reader', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_000));
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve(new Response(body));
      }),
    );
    expect(
      await failure(new MetricsQueryClient(settings).query('x')),
    ).toMatchObject({ reason: 'invalid_response' });
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(body.locked).toBe(false);
  });

  it('caps matrix total samples above 100,000 even when each series fits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: Array.from({ length: 101 }, () => ({
              metric: {},
              values: Array.from({ length: 1000 }, (_, i) => [i, '1']),
            })),
          },
        }),
      ),
    );
    expect(
      await failure(
        new MetricsQueryClient(settings).queryRange('x', 0, 999, 1),
      ),
    ).toMatchObject({ reason: 'invalid_response' });
  });

  it('times out slow bodies at 5000ms after headers arrive and keeps timeout through late cleanup', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let streamController:
      ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve(new Response(body));
      }),
    );
    let settled = false;
    const outcome = failure(new MetricsQueryClient(settings).query('x')).then(
      (error) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    streamController?.error(new Error('late synthetic-read-token failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(false);
    expect(error).toMatchObject({ reason: 'timeout' });
  });

  it.each(['fetch', 'body'])(
    'records timeout before abort triggers a different %s exception',
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: URL, init: RequestInit) => {
          signal = init.signal as AbortSignal;
          const abortError = metricsUnavailable('unauthorized');
          if (stage === 'fetch') {
            return new Promise<Response>((_resolve, reject) =>
              signal?.addEventListener('abort', () => reject(abortError), {
                once: true,
              }),
            );
          }
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  signal?.addEventListener(
                    'abort',
                    () => controller.error(abortError),
                    { once: true },
                  );
                },
              }),
            ),
          );
        }),
      );
      const outcome = failure(new MetricsQueryClient(settings).query('x'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toMatchObject({ reason: 'timeout' });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('clears deadline and aborts the signal after successful empty vector', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return Promise.resolve(
          Response.json({
            status: 'success',
            data: { resultType: 'vector', result: [] },
          }),
        );
      }),
    );
    expect(await new MetricsQueryClient(settings).query('x')).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('assertEnabled is a synchronous configuration guard without network', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const enabled = new MetricsQueryClient(settings);
    expect(typeof enabled.assertEnabled).toBe('function');
    expect(() => enabled.assertEnabled()).not.toThrow();
    expect(() =>
      new MetricsQueryClient({ query: null }).assertEnabled(),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the Grafana prefix and sends read credentials only in the Basic header', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(vector()));
    vi.stubGlobal('fetch', fetch);
    const result = await new MetricsQueryClient(settings).query(
      'node_load1{vm_id="vm"}',
    );
    expect(result).toEqual([
      { labels: { vm_id: 'vm' }, timestamp: 100, value: 0 },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      'https://metrics.example/api/prom/api/v1/query?query=node_load1%7Bvm_id%3D%22vm%22%7D',
    );
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('tenant:synthetic-read-token').toString('base64')}`,
    );
    expect(String(url)).not.toContain('synthetic-read-token');
  });
  describe.each([
    {
      mode: 'basic',
      auth: {
        mode: 'basic' as const,
        username: 'tenant',
        token: 'synthetic-read-token',
      },
    },
    {
      mode: 'bearer',
      auth: { mode: 'bearer' as const, token: 'synthetic-read-token' },
    },
    { mode: 'none', auth: { mode: 'none' as const } },
  ])('$mode auth', ({ mode, auth }) => {
    it.each([
      [
        'https://metrics.example/api/prom/',
        'https://metrics.example/api/prom/api/v1/',
      ],
      [
        'https://metrics.example/workspaces/ws-test///',
        'https://metrics.example/workspaces/ws-test/api/v1/',
      ],
      [
        'https://metrics.example/tenant%20space/api/prom/',
        'https://metrics.example/tenant%20space/api/prom/api/v1/',
      ],
      ['https://metrics.example/', 'https://metrics.example/api/v1/'],
    ])(
      'preserves query and range prefixes for all modes: %s',
      async (baseUrl, endpoint) => {
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(Response.json(vector('1.5')))
          .mockResolvedValueOnce(
            Response.json({
              status: 'success',
              data: {
                resultType: 'matrix',
                result: [
                  {
                    metric: { vm_id: 'vm' },
                    values: [
                      [10, '1.5'],
                      [30, 'NaN'],
                    ],
                  },
                ],
              },
            }),
          );
        vi.stubGlobal('fetch', fetch);
        const client = new MetricsQueryClient({ query: { baseUrl, auth } });
        const expression = 'node_load1{vm_id="vm space"} + 1';
        expect(await client.query(expression)).toEqual([
          { labels: { vm_id: 'vm' }, timestamp: 100, value: 1.5 },
        ]);
        expect(await client.queryRange(expression, 10, 30, 10)).toEqual([
          {
            labels: { vm_id: 'vm' },
            values: [
              { timestamp: 10, value: 1.5 },
              { timestamp: 30, value: null },
            ],
          },
        ]);
        expect(fetch.mock.calls).toHaveLength(2);
        const encoded = 'query=node_load1%7Bvm_id%3D%22vm+space%22%7D+%2B+1';
        expect(String(fetch.mock.calls[0][0])).toBe(
          `${endpoint}query?${encoded}`,
        );
        expect(String(fetch.mock.calls[1][0])).toBe(
          `${endpoint}query_range?${encoded}&start=10&end=30&step=10`,
        );
        for (const [url, init] of fetch.mock.calls) {
          expect(init.redirect).toBe('error');
          expect(init.headers.Accept).toBe('application/json');
          if (mode === 'none') {
            expect(init.headers).not.toHaveProperty('Authorization');
          } else if (mode === 'bearer') {
            expect(init.headers.Authorization).toBe(
              'Bearer synthetic-read-token',
            );
          } else {
            expect(init.headers.Authorization).toMatch(/^Basic /);
            expect(
              Buffer.from(
                init.headers.Authorization.slice(6),
                'base64',
              ).toString('utf8'),
            ).toBe('tenant:synthetic-read-token');
          }
          expect(String(url)).not.toContain('synthetic-read-token');
        }
      },
    );
  });

  it('normalizes empty success and finite matrix values without inventing nonfinite zeroes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status: 'success',
            data: { resultType: 'vector', result: [] },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  metric: {},
                  values: [
                    [10, '1.5'],
                    [20, 'NaN'],
                    [30, '+Inf'],
                  ],
                },
              ],
            },
          }),
        ),
    );
    const client = new MetricsQueryClient(settings);
    expect(await client.query('x')).toEqual([]);
    expect(await client.queryRange('x', 10, 30, 10)).toEqual([
      {
        labels: {},
        values: [
          { timestamp: 10, value: 1.5 },
          { timestamp: 20, value: null },
          { timestamp: 30, value: null },
        ],
      },
    ]);
  });
  it.each([
    Response.json({ status: 'error', error: 'synthetic-read-token' }),
    Response.json({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    }),
    Response.json({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: {}, value: ['bad', '2'] }],
      },
    }),
    new Response('synthetic-read-token', { status: 401 }),
    new Response('{bad synthetic-read-token'),
    new Response('x'.repeat(2_000_001)),
  ])(
    'sanitizes HTTP/provider/malformed/oversize failures',
    async (response) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response.clone()));
      await expect(
        new MetricsQueryClient(settings).query('x'),
      ).rejects.toMatchObject({
        response: {
          code: 'METRICS_UNAVAILABLE',
          message: 'Metrics are temporarily unavailable',
        },
      });
    },
  );
  it('rejects disabled query before network and refuses invalid range sizes', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      new MetricsQueryClient({ query: null }).query('x'),
    ).rejects.toMatchObject({ response: { code: 'METRICS_DISABLED' } });
    await expect(
      new MetricsQueryClient(settings).queryRange('x', 0, 604801, 1),
    ).rejects.toMatchObject({ response: { code: 'METRICS_UNAVAILABLE' } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds stalled requests even if a transport ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let settled = false;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: URL, init: RequestInit) => {
          signal = init.signal as AbortSignal;
          return new Promise(() => undefined);
        }),
      );
      const outcome = failure(new MetricsQueryClient(settings).query('x')).then(
        (error) => {
          settled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ reason: 'timeout' });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('caps provider sample counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: {},
                values: Array.from({ length: 1001 }, (_, i) => [i, '1']),
              },
            ],
          },
        }),
      ),
    );
    await expect(
      new MetricsQueryClient(settings).queryRange('x', 0, 999, 1),
    ).rejects.toMatchObject({ response: { code: 'METRICS_UNAVAILABLE' } });
  });
});
