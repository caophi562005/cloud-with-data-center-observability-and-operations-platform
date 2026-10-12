import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { get as httpsGet } from 'node:https';
import express from 'express';
import request from 'supertest';
import { SNSClient, ConfirmSubscriptionCommand } from '@aws-sdk/client-sns';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { AlertRepository } from '../src/modules/alerts/alert.repository.js';
import {
  AlertInputError,
  AlertUnavailableError,
  SnsSignatureError,
  type CanonicalAlertEvent,
} from '../src/modules/alerts/alert.types.js';
import { adaptAmpAlertMessage } from '../src/modules/alerts/adapters/amp/amp-alert.adapter.js';
import {
  occurrenceKey,
  transitionOccurrence,
} from '../src/modules/alerts/alert-lifecycle.js';
import {
  snsAlertsConfig,
  type SnsAlertsConfig,
} from '../src/config/sns-alerts.config.js';
import { SnsCertificateProvider } from '../src/modules/alerts/sns/sns-certificate.provider.js';
import {
  buildSnsSigningString,
  type SnsEnvelope,
} from '../src/modules/alerts/sns/sns-envelope.js';
import { snsBodyMiddleware } from '../src/modules/alerts/sns/sns-body.middleware.js';

// Fail closed even if a certificate URL validation regression reaches fetch.
vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  get: vi.fn(() => {
    throw new Error('External HTTPS disabled in local SNS fixture');
  }),
}));

// Loopback-only fixture config; live AWS, Redis and PostgreSQL boundaries overridden.
vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3100',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/sns_gate_a_no_database',
    REDIS_URL: 'redis://127.0.0.1:1',
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
    COGNITO_CLIENT_ID: 'test-client',
    COGNITO_CLIENT_SECRET: 'test-secret',
    SNS_ALERTS_ENABLED: 'true',
    SNS_ALERTS_TOPIC_ARN:
      'arn:aws:sns:ap-southeast-1:491333778094:opsgrid-dev-amp-alerts',
    SNS_ALERTS_REGION: 'ap-southeast-1',
  }),
);
const topic = 'arn:aws:sns:ap-southeast-1:491333778094:opsgrid-dev-amp-alerts';
const configuration: SnsAlertsConfig = {
  enabled: true,
  topicArn: topic,
  region: 'ap-southeast-1',
  source: 'metrics-primary',
};
const org = '11111111-1111-4111-8111-111111111111',
  vm = '22222222-2222-4222-8222-222222222222';
const started = '2026-10-10T00:00:00.000000001Z';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
function payload(status: 'firing' | 'resolved' = 'firing', startsAt = started) {
  const labels = {
    organization_id: org,
    vm_id: vm,
    alertname: 'VMHighCPU',
    severity: 'warning',
  };
  return {
    schemaVersion: 1,
    stringEncoding: 'urlquery',
    receiver: 'opsgrid-sns',
    status,
    groupLabels: { organization_id: org, vm_id: vm, alertname: 'VMHighCPU' },
    alerts: [
      {
        status,
        labels,
        annotations: { summary: 'A+B%2BC%2520', description: 'CPU+over+80%25' },
        fingerprint: 'e2e_fixture_only',
        startsAt,
        endsAt:
          status === 'resolved'
            ? '2026-10-10T00:10:00.000000001Z'
            : '0001-01-01T00:00:00Z',
      },
    ],
  };
}
function envelope(
  message: string,
  version: '1' | '2' = '2',
  subject?: string,
): SnsEnvelope {
  const value: SnsEnvelope = {
    Type: 'Notification',
    Message: message,
    MessageId: 'fixture-message-id',
    Timestamp: started,
    TopicArn: topic,
    SignatureVersion: version,
    Signature: 'placeholder',
    SigningCertURL:
      'https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-fixture.pem',
    ...(subject === undefined ? {} : { Subject: subject }),
  };
  return signed(value);
}
function signed<T extends SnsEnvelope>(value: T): T {
  return {
    ...value,
    Signature: sign(
      value.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
      Buffer.from(buildSnsSigningString(value)),
      key.privateKey,
    ).toString('base64'),
  };
}

describe('SNS HTTP ingestion (external boundaries mocked; NOT real PG/AWS delivery)', () => {
  let app: INestApplication;
  const persist = vi.fn(
    async (_events: readonly CanonicalAlertEvent[], _deadlineAt: number) => ({
      created: 1,
      resolved: 0,
      unchanged: 0,
      metadataUpdated: 0,
    }),
  );
  const certificate = vi.fn(async () => ({
    publicKey: key.publicKey,
    notBefore: 0,
    notAfter: Date.now() + 60_000,
    provenanceUrl: 'fixture',
  }));
  const send = vi
    .spyOn(SNSClient.prototype, 'send')
    .mockImplementation(async () => ({
      $metadata: {},
      SubscriptionArn: `${topic}:fixture-subscription`,
    }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ ping: vi.fn(async () => 'PONG') })
      .overrideProvider(CacheService)
      .useValue({
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      })
      .overrideProvider(AlertRepository)
      .useValue({ persistBatch: persist })
      .overrideProvider(SnsCertificateProvider)
      .useValue({ getSigningKey: certificate })
      .overrideProvider(snsAlertsConfig.KEY)
      .useValue(configuration)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await configureApp(app, {
      nodeEnv: 'test',
      webUrl: 'http://localhost:5173',
      snsAlertsEnabled: true,
    });
    await app.init();
  });
  beforeEach(() => {
    persist.mockClear();
    certificate.mockClear();
    send.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    send.mockRestore();
  });
  it.each([
    ['1', undefined],
    ['1', ''],
    ['2', undefined],
    ['2', 'OpsGrid VM alerts'],
  ] as const)(
    'verifies real RSA v%s Subject=%s and normalizes before persistence',
    async (version, subject) => {
      await request(app.getHttpServer())
        .post('/api/v1/alerts/sns')
        .set('Content-Type', 'text/plain; charset=UTF-8')
        .send(
          JSON.stringify(envelope(JSON.stringify(payload()), version, subject)),
        )
        .expect(200);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({
          source: 'metrics-primary',
          status: 'FIRING',
          startsAt: started,
          annotations: { summary: 'A B+C%20', description: 'CPU over 80%' },
        }),
      ]);
    },
  );
  it('verifies confirmation then sends exact-topic authenticated-unsubscribe command, without DB', async () => {
    const confirmation = signed({
      Type: 'SubscriptionConfirmation',
      Message: 'confirmation fixture',
      MessageId: 'confirm-id',
      Timestamp: started,
      TopicArn: topic,
      SignatureVersion: '2',
      Signature: 'placeholder',
      SigningCertURL:
        'https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-fixture.pem',
      Token: 'fixture-token',
      SubscribeURL: 'https://sns.ap-southeast-1.amazonaws.com/?fixture',
    } satisfies SnsEnvelope);
    await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .set('Origin', 'https://not-the-browser.example')
      .send(confirmation)
      .expect(200);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConfirmSubscriptionCommand);
    expect((command as ConfirmSubscriptionCommand).input).toEqual({
      TopicArn: topic,
      Token: 'fixture-token',
      AuthenticateOnUnsubscribe: 'true',
    });
    expect(persist).not.toHaveBeenCalled();
  });
  it('rejects a changed signature without persistence or confirmation', async () => {
    const input = envelope(JSON.stringify(payload()));
    input.Message += ' ';
    await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .send(input)
      .expect(403);
    expect(persist).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects wrong topic before certificate lookup', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .send({ ...envelope('{}'), TopicArn: `${topic}-other` })
      .expect(403);
    expect(certificate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  it('rejects correctly signed malformed inner message', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .send(envelope('{malformed'))
      .expect(400);
    expect(persist).not.toHaveBeenCalled();
  });
  it('returns retryable sanitized 503, not 2xx, on persistence failure', async () => {
    persist.mockRejectedValueOnce(new AlertUnavailableError());
    const response = await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .send(envelope(JSON.stringify(payload())))
      .expect(503);
    expect(response.body).toEqual({ code: 'ALERTS_UNAVAILABLE' });
  });
  it('covers case-insensitive/trailing slash path and enforces body bounds', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ALERTS/SNS/')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(envelope(JSON.stringify(payload()))))
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/alerts/sns')
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(512 * 1024 + 1))
      .expect(413);
  });
});

describe('canonical adapter and lifecycle (no database)', () => {
  const firing = adaptAmpAlertMessage(JSON.stringify(payload()))[0]!;
  const resolved = adaptAmpAlertMessage(
    JSON.stringify(payload('resolved')),
  )[0]!;
  it('creates firing and deduplicates without mutating the incoming event', () => {
    expect(transitionOccurrence(null, firing).kind).toBe('INSERT');
    expect(transitionOccurrence(firing, firing).kind).toBe('NOOP');
  });
  it('resolves and never reopens on late firing', () => {
    const closed = transitionOccurrence(firing, resolved).event;
    expect(closed.status).toBe('RESOLVED');
    expect(transitionOccurrence(closed, firing).event.status).toBe('RESOLVED');
    expect(transitionOccurrence(null, resolved).event.status).toBe('RESOLVED');
  });
  it('keeps nanosecond recurrence identity even when Date loses precision', () => {
    const recurrence = adaptAmpAlertMessage(
      JSON.stringify(payload('firing', '2026-10-10T00:00:00.000000002Z')),
    )[0]!;
    expect(new Date(firing.startsAt).valueOf()).toBe(
      new Date(recurrence.startsAt).valueOf(),
    );
    expect(occurrenceKey(firing)).not.toBe(occurrenceKey(recurrence));
  });
  it('rejects immutable severity conflict', () => {
    expect(() =>
      transitionOccurrence(firing, { ...firing, severity: 'CRITICAL' }),
    ).toThrow(AlertInputError);
  });
  it.each(['tenant', 'bad-encoding', 'conflicting-duplicate'])(
    'rejects whole malformed batch: %s',
    (kind) => {
      const input = payload();
      if (kind === 'tenant')
        input.alerts[0]!.labels.vm_id = '33333333-3333-4333-8333-333333333333';
      if (kind === 'bad-encoding') input.alerts[0]!.annotations.summary = '%ZZ';
      if (kind === 'conflicting-duplicate')
        input.alerts.push({
          ...input.alerts[0]!,
          status: 'resolved',
          endsAt: '2026-10-10T00:10:00.000000001Z',
        });
      expect(() => adaptAmpAlertMessage(JSON.stringify(input))).toThrow(
        AlertInputError,
      );
    },
  );
});

describe('route bounds and certificate origin (no external network)', () => {
  it.each([
    'https://sns.ap-southeast-1.amazonaws.com.evil.example/SimpleNotificationService-x.pem',
    'http://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-x.pem',
    'https://sns.ap-southeast-1.amazonaws.com:444/SimpleNotificationService-x.pem',
    'https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-x.pem?redirect=1',
  ])('rejects cert URL %s before network', async (url) => {
    vi.mocked(httpsGet).mockClear();
    await expect(
      new SnsCertificateProvider(configuration).getSigningKey(
        url,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow(SnsSignatureError);
    expect(httpsGet).not.toHaveBeenCalled();
  });
  it('disabled route returns no-store 503 before parsing/next', async () => {
    const next = vi.fn();
    const server = express().use(snsBodyMiddleware(false)).use(next);
    await request(server)
      .post('/api/v1/alerts/sns')
      .send({})
      .expect('Cache-Control', 'no-store')
      .expect(503);
    expect(next).not.toHaveBeenCalled();
  });
  it('enforces real wall-clock deadline while body is stalled, never advances next', async () => {
    const next = vi.fn();
    const server = express()
      .use(snsBodyMiddleware(true))
      .use(next)
      .listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback listener');
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/v1/alerts/sns',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '64' },
    });
    try {
      const status = new Promise<number | undefined>((resolve, reject) => {
        client.once('response', (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        client.once('error', reject);
      });
      client.write('{');
      expect(await status).toBe(503);
      expect(next).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 12_000);
});
