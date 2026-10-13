import { Writable } from 'node:stream';
import * as pinoHttpModule from 'pino-http';
import type { HttpLogger, Options } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { loggerRedactionPaths } from './common/logging/logger-redaction.js';

type PinoHttpFactory = (options?: Options) => HttpLogger;
const pinoHttp = pinoHttpModule.default as unknown as PinoHttpFactory;

describe('AppModule logger redaction', () => {
  it.each(['basic', 'bearer'] as const)(
    'redacts nested metrics auth tokens (%s) independently of broad query censorship',
    (mode) => {
      const marker = 'synthetic-nested-secret-marker';
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      });
      const logger = pinoHttp({
        // Exercise the explicit token paths: '*.query' otherwise masks the whole object.
        redact: {
          paths: loggerRedactionPaths.filter((path) => path !== '*.query'),
          censor: '[REDACTED]',
        },
        stream,
        autoLogging: false,
      }).logger;
      logger.info(
        {
          metrics: { query: { token: marker, auth: { mode, token: marker } } },
        },
        'synthetic response log',
      );
      const output = chunks.join('');
      expect(output).not.toContain(marker);
      expect(JSON.parse(output)).toMatchObject({
        metrics: {
          query: { token: '[REDACTED]', auth: { mode, token: '[REDACTED]' } },
        },
      });
    },
  );
  it.each(['basic', 'bearer'] as const)(
    'redacts nested metrics auth tokens (%s), response headers, request URLs, and secret fields before Pino output',
    (mode) => {
      const marker = 'synthetic-secret-marker';
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      });
      const logger = pinoHttp({
        redact: {
          paths: [...loggerRedactionPaths],
          censor: '[REDACTED]',
        },
        stream,
        autoLogging: false,
        serializers: {
          res: (value: unknown) => value,
        },
      }).logger;

      logger.info(
        {
          req: {
            url: `https://provider.example/${marker}`,
            originalUrl: marker,
            query: { token: marker },
            headers: {
              Authorization: `Bearer ${marker}`,
              authorization: marker,
              providerBody: `raw-provider-body-${marker}`,
            },
            cookies: { refresh_token: marker },
            body: {
              credential: marker,
              agentCredential: marker,
              enrollmentToken: marker,
            },
          },
          res: {
            headers: { 'set-cookie': [`access_token=${marker}`] },
          },
          cookies: { access_token: marker },
          url: marker,
          password: marker,
          token: marker,
          clientSecret: marker,
          secret: marker,
          credential: marker,
          agentCredential: marker,
          enrollmentToken: marker,
          authorization: marker,
          METRICS_QUERY_TOKEN: marker,
          METRICS_WRITE_TOKEN: marker,
          environment: {
            METRICS_QUERY_TOKEN: marker,
            METRICS_WRITE_TOKEN: marker,
          },
          metrics: { query: { token: marker, auth: { mode, token: marker } } },
        },
        'synthetic response log',
      );

      const output = chunks.join('');
      expect(output).not.toContain(marker);
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('Authorization');
      expect(output).not.toContain('raw-provider-body');
      expect(output).not.toContain('https://provider.example');
      expect(JSON.parse(output)).toMatchObject({
        METRICS_QUERY_TOKEN: '[REDACTED]',
        METRICS_WRITE_TOKEN: '[REDACTED]',
        environment: {
          METRICS_QUERY_TOKEN: '[REDACTED]',
          METRICS_WRITE_TOKEN: '[REDACTED]',
        },
        metrics: { query: '[REDACTED]' },
      });
    },
  );
});
