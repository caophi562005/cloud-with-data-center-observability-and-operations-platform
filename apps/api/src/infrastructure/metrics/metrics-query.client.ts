import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  metricsConfig,
  type MetricsConfig,
} from '../../config/metrics.config.js';
import type {
  MetricMatrix,
  MetricSample,
  MetricVector,
} from './metrics.types.js';

const MAX_BYTES = 2_000_000;
const labelsSchema = z.record(z.string().max(256), z.string().max(4096));
const sampleSchema = z.tuple([
  z.number().finite().nonnegative().max(8_640_000_000_000),
  z.string().max(100),
]);
const vectorSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z
      .array(z.object({ metric: labelsSchema, value: sampleSchema }))
      .max(1000),
  }),
});
const matrixSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z
      .array(
        z.object({
          metric: labelsSchema,
          values: z.array(sampleSchema).max(1000),
        }),
      )
      .max(1000),
  }),
});
export type MetricsFailureReason =
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'client_error'
  | 'server_error'
  | 'invalid_response'
  | 'redirect';

export class MetricsUnavailableException extends ServiceUnavailableException {
  constructor(readonly reason: MetricsFailureReason) {
    super({
      code: 'METRICS_UNAVAILABLE',
      message: 'Metrics are temporarily unavailable',
    });
  }
}

export function metricsUnavailable(
  reason: MetricsFailureReason = 'invalid_response',
): ServiceUnavailableException {
  return new MetricsUnavailableException(reason);
}
function sample([timestamp, raw]: [number, string]): MetricSample {
  const value = raw.trim() === '' ? NaN : Number(raw);
  return { timestamp, value: Number.isFinite(value) ? value : null };
}

@Injectable()
export class MetricsQueryClient {
  constructor(
    @Inject(metricsConfig.KEY) private readonly settings: MetricsConfig,
  ) {}
  assertEnabled(): void {
    if (!this.settings.query)
      throw new ServiceUnavailableException({
        code: 'METRICS_DISABLED',
        message: 'Metrics are not configured',
      });
  }
  async listRuleGroups(): Promise<unknown[]> {
    const schema = z.object({
      status: z.literal('success'),
      data: z.object({
        groups: z.array(z.unknown()).max(100),
        groupNextToken: z.string().max(4096).optional(),
      }),
    });
    const groups: unknown[] = [];
    const tokens = new Set<string>();
    const deadline = Date.now() + 5000;
    let token = '';
    for (let page = 0; page < 5; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw metricsUnavailable('timeout');
      const payload = await this.request(
        'rules',
        {
          type: 'alert',
          'file[]': 'opsgrid-dev-vm-alerts',
          'rule_group[]': 'opsgrid-vm-health',
          group_limit: '100',
          ...(token ? { group_next_token: token } : {}),
        },
        remaining,
      );
      const parsed = schema.safeParse(payload);
      if (
        !parsed.success ||
        groups.length + parsed.data.data.groups.length > 100
      )
        throw metricsUnavailable();
      groups.push(...parsed.data.data.groups);
      token = parsed.data.data.groupNextToken ?? '';
      if (!token) return groups;
      if (tokens.has(token)) throw metricsUnavailable();
      tokens.add(token);
    }
    throw metricsUnavailable();
  }
  async query(expression: string): Promise<MetricVector[]> {
    const payload = await this.request('query', { query: expression });
    const parsed = vectorSchema.safeParse(payload);
    if (!parsed.success) throw metricsUnavailable();
    return parsed.data.data.result.map(({ metric, value }) => ({
      labels: metric,
      ...sample(value),
    }));
  }
  async queryRange(
    expression: string,
    from: number,
    to: number,
    step: number,
  ): Promise<MetricMatrix[]> {
    if (
      ![from, to, step].every(Number.isFinite) ||
      from < 0 ||
      to <= from ||
      to - from > 604800 ||
      !Number.isInteger(step) ||
      step <= 0 ||
      Math.floor((to - from) / step) + 1 > 1000
    )
      throw metricsUnavailable();
    const payload = await this.request('query_range', {
      query: expression,
      start: String(from),
      end: String(to),
      step: String(step),
    });
    const parsed = matrixSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.data.result.reduce(
        (n, series) => n + series.values.length,
        0,
      ) > 100_000
    )
      throw metricsUnavailable();
    return parsed.data.data.result.map(({ metric, values }) => ({
      labels: metric,
      values: values.map(sample),
    }));
  }
  private async request(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs = 5000,
  ): Promise<unknown> {
    this.assertEnabled();
    const config = this.settings.query!;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const url = new URL(
        `${config.baseUrl.replace(/\/+$/, '')}/api/v1/${endpoint}`,
      );
      const isQuery = endpoint === 'query' || endpoint === 'query_range';
      const form = new URLSearchParams(params);
      if (!isQuery) url.search = form.toString();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Abort listeners can reject with another error before the race settles.
          timedOut = true;
          abort.abort();
          reject(metricsUnavailable('timeout'));
        }, timeoutMs);
      });
      return await Promise.race([
        deadline,
        (async () => {
          const headers: Record<string, string> = {
            Accept: 'application/json',
          };
          if (config.auth.mode === 'basic') {
            headers.Authorization = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.token}`).toString('base64')}`;
          } else if (config.auth.mode === 'bearer') {
            headers.Authorization = `Bearer ${config.auth.token}`;
          }
          if (isQuery) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
          }
          const response = await fetch(url, {
            method: isQuery ? 'POST' : 'GET',
            ...(isQuery ? { body: form } : {}),
            redirect: 'error',
            signal: abort.signal,
            headers,
          });
          if (
            response.redirected ||
            (response.status >= 300 && response.status < 400)
          )
            throw metricsUnavailable('redirect');
          if (response.status === 401 || response.status === 403)
            throw metricsUnavailable('unauthorized');
          if (response.status >= 400 && response.status < 500)
            throw metricsUnavailable('client_error');
          if (response.status >= 500 && response.status < 600)
            throw metricsUnavailable('server_error');
          if (
            !response.ok ||
            Number(response.headers.get('content-length')) > MAX_BYTES ||
            !response.body
          )
            throw metricsUnavailable('invalid_response');
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > MAX_BYTES) {
                void reader.cancel().catch(() => undefined);
                throw metricsUnavailable();
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          try {
            return JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as unknown;
          } catch {
            throw metricsUnavailable('invalid_response');
          }
        })(),
      ]);
    } catch (error) {
      if (timedOut) throw metricsUnavailable('timeout');
      if (error instanceof MetricsUnavailableException) throw error;
      throw metricsUnavailable('network');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
    }
  }
}
