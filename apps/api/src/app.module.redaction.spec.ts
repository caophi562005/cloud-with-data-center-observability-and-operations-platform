import { Writable } from 'node:stream';
import * as pinoHttpModule from 'pino-http';
import type { HttpLogger, Options } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { loggerRedactionPaths } from './common/logging/logger-redaction.js';

type PinoHttpFactory = (options?: Options) => HttpLogger;
const pinoHttp = pinoHttpModule.default as unknown as PinoHttpFactory;

describe('AppModule logger redaction', () => {
  it('redacts response headers, request URLs, and secret fields before Pino output', () => {
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
          url: marker,
          originalUrl: marker,
          query: { token: marker },
          headers: { authorization: marker },
          cookies: { refresh_token: marker },
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
        authorization: marker,
      },
      'synthetic response log',
    );

    const output = chunks.join('');
    expect(output).not.toContain(marker);
    expect(output).toContain('[REDACTED]');
  });
});
