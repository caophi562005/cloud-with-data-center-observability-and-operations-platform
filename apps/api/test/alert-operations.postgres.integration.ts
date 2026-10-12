import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { occurrenceKey } from '../src/modules/alerts/alert-lifecycle.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { AlertRepository } from '../src/modules/alerts/alert.repository.js';
import type { CanonicalAlertEvent } from '../src/modules/alerts/alert.types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireIsolatedPostgresTestUrl } from './support/alert-operations-postgres.js';

const org = '11111111-1111-4111-8111-111111111111';
const vm = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const secondUser = '44444444-4444-4444-8444-444444444444';
const legacy = '77777777-7777-4777-8777-777777777777';
let database: Client;
let legacyBefore: unknown;
let prisma: PrismaService;
let repository: AlertRepository;

beforeAll(async () => {
  // NEVER infer a database from application configuration or ambient DATABASE_URL.
  database = new Client({
    connectionString: requireIsolatedPostgresTestUrl(process.env),
  });
  await database.connect();
  const target = await database.query<{ name: string }>(
    'SELECT current_database() AS name',
  );
  if (target.rows[0]?.name !== 'opsgrid_alert_operations_test')
    throw new Error('Unexpected isolated PostgreSQL database');
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const migration of [
    '20261010030000_observed_domain_baseline',
    '20261010031000_alert_ingestion',
  ]) {
    await database.query(
      await readFile(
        new URL(
          `../prisma/migrations-current/${migration}/migration.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  }
  await database.query(
    `INSERT INTO "User" (id,"cognitoSub",email,"updatedAt") VALUES ($1,'fixture-subject','fixture@example.invalid',now())`,
    [user],
  );
  await database.query(
    `INSERT INTO "User" (id,"cognitoSub",email,"updatedAt") VALUES ($1,'fixture-second','second@example.invalid',now())`,
    [secondUser],
  );
  await database.query(
    `INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,'Fixture','fixture',now())`,
    [org],
  );
  await database.query(
    `INSERT INTO "Vm" (id,"organizationId",hostname,"updatedAt") VALUES ($1,$2,'fixture',now())`,
    [vm, org],
  );
  await database.query(
    `INSERT INTO alerts (id,source,"organizationId","vmId",fingerprint,"alertName",severity,status,"startsAt","startsAtKey",labels,annotations,"updatedAt")
    VALUES ($1,'metrics-primary',$2,$3,'legacy','VMHighCPU','WARNING','FIRING','2026-10-10T00:00:00.123456789Z','2026-10-10T00:00:00.123456789Z','{}','{}',now())`,
    [legacy, org, vm],
  );
  legacyBefore = (
    await database.query(
      'SELECT to_jsonb(a) AS row FROM alerts a WHERE id=$1',
      [legacy],
    )
  ).rows[0].row;
  const addition = new URL(
    '../prisma/migrations-current/20261010100000_alert_operations/migration.sql',
    import.meta.url,
  );
  if (existsSync(addition))
    await database.query(await readFile(addition, 'utf8'));
  prisma = new PrismaService(
    new ConfigService({
      database: { url: requireIsolatedPostgresTestUrl(process.env) },
    }),
  );
  await prisma.$connect();
  repository = new AlertRepository(prisma);
});
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (database) await database.end();
});

describe('schema migration', () => {
  it('gives legacy alerts only OPEN/null defaults without rewriting signal data', async () => {
    const row = (
      await database.query(
        'SELECT to_jsonb(a) AS row FROM alerts a WHERE id=$1',
        [legacy],
      )
    ).rows[0].row;
    expect(row.workflowStatus).toBe('OPEN');
    expect(row.acknowledgedBy).toBeNull();
    expect(row.acknowledgedAt).toBeNull();
    const {
      workflowStatus: _status,
      acknowledgedBy: _actor,
      acknowledgedAt: _time,
      ...preserved
    } = row;
    expect(preserved).toEqual(legacyBefore);
  });
  it('creates empty history instead of inventing legacy observations', async () => {
    const catalog = await database.query(
      "SELECT to_regclass('public.alert_events')::text AS name",
    );
    expect(catalog.rows[0].name).toBe('alert_events');
    expect(
      (await database.query('SELECT count(*)::int AS count FROM alert_events'))
        .rows[0].count,
    ).toBe(0);
  });
  it('rejects incomplete acknowledgement at the database boundary', async () => {
    await expect(
      database.query(
        `UPDATE alerts SET "workflowStatus"='ACKNOWLEDGED' WHERE id=$1`,
        [legacy],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query(
        `UPDATE alerts SET "acknowledgedBy"=$2,"acknowledgedAt"=now() WHERE id=$1`,
        [legacy, user],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('restricts actor deletion rather than erasing acknowledgement attribution', async () => {
    await database.query(
      `UPDATE alerts SET "workflowStatus"='ACKNOWLEDGED',"acknowledgedBy"=$2,"acknowledgedAt"=now() WHERE id=$1`,
      [legacy, user],
    );
    await expect(
      database.query('DELETE FROM "User" WHERE id=$1', [user]),
    ).rejects.toMatchObject({ code: '23001' });
    await database.query(
      `UPDATE alerts SET "workflowStatus"='OPEN',"acknowledgedBy"=NULL,"acknowledgedAt"=NULL WHERE id=$1`,
      [legacy],
    );
  });
  it('enforces event shapes and positive sequence while allowing repeated comments', async () => {
    const insert = (
      sequence: number,
      type: string,
      actor: string | null,
      message: string | null,
      time: string | null,
    ) =>
      database.query(
        `INSERT INTO alert_events (id,"alertId",sequence,type,"actorId",message,"sourceTimeKey") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), legacy, sequence, type, actor, message, time],
      );
    await expect(
      insert(0, 'ALERT_FIRING', null, null, '2026-10-10T00:00:00.123456789Z'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(1, 'ALERT_FIRING', user, null, '2026-10-10T00:00:00.123456789Z'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(1, 'ACKNOWLEDGED', null, null, null),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(1, 'COMMENT_ADDED', user, ' ', null),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(1, 'COMMENT_ADDED', user, 'x'.repeat(4001), null),
    ).rejects.toMatchObject({ code: '23514' });
    await insert(1, 'COMMENT_ADDED', user, 'same', null);
    await insert(2, 'COMMENT_ADDED', user, 'same', null);
    await expect(
      insert(2, 'COMMENT_ADDED', user, 'duplicate sequence', null),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      database.query('DELETE FROM "User" WHERE id=$1', [user]),
    ).rejects.toMatchObject({ code: '23001' });
    await database.query('DELETE FROM alert_events WHERE "alertId"=$1', [
      legacy,
    ]);
  });
  it('retains composite tenant ownership and cascades events only with their alert lifetime', async () => {
    const otherOrg = randomUUID(),
      otherVm = randomUUID(),
      otherAlert = randomUUID();
    await database.query(
      `INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,'Other',$2,now())`,
      [otherOrg, otherOrg],
    );
    await database.query(
      `INSERT INTO "Vm" (id,"organizationId",hostname,"updatedAt") VALUES ($1,$2,'other',now())`,
      [otherVm, otherOrg],
    );
    const insert = (organizationId: string, vmId: string) =>
      database.query(
        `INSERT INTO alerts (id,source,"organizationId","vmId",fingerprint,"alertName",severity,status,"startsAt","startsAtKey",labels,annotations,"updatedAt") VALUES ($1,'metrics-primary',$2,$3,'cascade','VMHighCPU','WARNING','FIRING',now(),'2026-10-10T00:00:00.000000000Z','{}','{}',now())`,
        [otherAlert, organizationId, vmId],
      );
    await expect(insert(otherOrg, vm)).rejects.toMatchObject({ code: '23503' });
    await insert(otherOrg, otherVm);
    await database.query(
      `INSERT INTO alert_events (id,"alertId",sequence,type,"sourceTimeKey") VALUES ($1,$2,1,'ALERT_FIRING','2026-10-10T00:00:00.000000000Z')`,
      [randomUUID(), otherAlert],
    );
    await database.query('DELETE FROM "Vm" WHERE id=$1', [otherVm]);
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS count FROM alerts WHERE id=$1',
          [otherAlert],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS count FROM alert_events WHERE "alertId"=$1',
          [otherAlert],
        )
      ).rows[0].count,
    ).toBe(0);
    await database.query('DELETE FROM "Organization" WHERE id=$1', [otherOrg]);
  });
});

function signal(
  fingerprint: string = randomUUID(),
  startsAt = '2026-10-10T00:00:00.123456789Z',
): CanonicalAlertEvent {
  return {
    source: 'metrics-primary',
    organizationId: org,
    vmId: vm,
    fingerprint,
    alertName: 'VMHighCPU',
    severity: 'WARNING',
    status: 'FIRING',
    startsAt,
    endsAt: null,
    labels: {
      organization_id: org,
      vm_id: vm,
      alertname: 'VMHighCPU',
      severity: 'warning',
    },
    annotations: {},
  };
}
const ingest = (events: readonly CanonicalAlertEvent[]) =>
  repository.persistBatch(events, Date.now() + 5000);
const history = async (fingerprint: string) =>
  (
    await database.query(
      `SELECT e.type,e.sequence,e."sourceTimeKey",e."actorId",e.message FROM alert_events e JOIN alerts a ON a.id=e."alertId" WHERE a.fingerprint=$1 ORDER BY e.sequence`,
      [fingerprint],
    )
  ).rows;
describe('real PostgreSQL observed signal history', () => {
  it('records first firing/resolution only and never reopens late firing', async () => {
    const incoming = signal();
    expect((await ingest([incoming])).created).toBe(1);
    expect((await ingest([incoming])).unchanged).toBe(1);
    const resolved = {
      ...incoming,
      status: 'RESOLVED' as const,
      endsAt: '2026-10-10T00:10:00.000000001Z',
    };
    expect((await ingest([resolved])).resolved).toBe(1);
    expect((await ingest([resolved])).unchanged).toBe(1);
    expect((await ingest([incoming])).unchanged).toBe(1);
    expect(await history(incoming.fingerprint)).toEqual([
      {
        type: 'ALERT_FIRING',
        sequence: 1,
        sourceTimeKey: incoming.startsAt,
        actorId: null,
        message: null,
      },
      {
        type: 'ALERT_RESOLVED',
        sequence: 2,
        sourceTimeKey: resolved.endsAt,
        actorId: null,
        message: null,
      },
    ]);
  });
  it('records resolved-first only, not an inferred firing', async () => {
    const incoming = {
      ...signal(),
      status: 'RESOLVED' as const,
      endsAt: '2026-10-10T00:10:00.000000001Z',
    };
    await ingest([incoming]);
    expect(await history(incoming.fingerprint)).toEqual([
      {
        type: 'ALERT_RESOLVED',
        sequence: 1,
        sourceTimeKey: incoming.endsAt,
        actorId: null,
        message: null,
      },
    ]);
  });
  it('leaves legacy/noop and annotation-only history empty until a real transition', async () => {
    const incoming = signal('legacy');
    expect((await ingest([incoming])).unchanged).toBe(1);
    expect(
      (
        await ingest([
          { ...incoming, annotations: { summary: 'observed metadata' } },
        ])
      ).metadataUpdated,
    ).toBe(1);
    expect(await history(incoming.fingerprint)).toEqual([]);
    await ingest([
      {
        ...incoming,
        status: 'RESOLVED',
        endsAt: '2026-10-10T00:10:00.000000001Z',
      },
    ]);
    expect(
      (await history(incoming.fingerprint)).map((row) => row.type),
    ).toEqual(['ALERT_RESOLVED']);
  });
  it('rolls back the whole alert/event batch on a later event-write failure', async () => {
    const first = signal('atomic-a-' + randomUUID()),
      second = {
        ...signal('atomic-b-' + randomUUID()),
        status: 'RESOLVED' as const,
        endsAt: '2026-10-10T00:10:00.000000001Z',
      };
    await database.query(
      `CREATE FUNCTION fixture_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='ALERT_RESOLVED' THEN RAISE EXCEPTION 'fixture event failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reject_event BEFORE INSERT ON alert_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_event();`,
    );
    try {
      await expect(ingest([first, second])).rejects.toThrow(
        'Alert ingestion unavailable',
      );
      expect(
        (
          await database.query(
            'SELECT count(*)::int AS count FROM alerts WHERE fingerprint=ANY($1::text[])',
            [[first.fingerprint, second.fingerprint]],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(await history(first.fingerprint)).toEqual([]);
    } finally {
      await database.query(
        'DROP TRIGGER fixture_reject_event ON alert_events; DROP FUNCTION fixture_reject_event()',
      );
    }
  });
  it('preserves distinct nanosecond occurrence identity', async () => {
    const first = signal(),
      second = { ...first, startsAt: '2026-10-10T00:00:00.123456790Z' };
    expect((await ingest([first, second])).created).toBe(2);
    const rows = await database.query(
      'SELECT "startsAtKey" FROM alerts WHERE fingerprint=$1 ORDER BY "startsAtKey"',
      [first.fingerprint],
    );
    expect(rows.rows.map((row) => row.startsAtKey)).toEqual([
      first.startsAt,
      second.startsAt,
    ]);
    expect(
      (await history(first.fingerprint)).map((row) => row.sourceTimeKey).sort(),
    ).toEqual([first.startsAt, second.startsAt]);
  });
});

async function persistedSignal(incoming = signal()) {
  await ingest([incoming]);
  return prisma.alert.findFirstOrThrow({
    where: {
      organizationId: org,
      fingerprint: incoming.fingerprint,
      startsAtKey: incoming.startsAt,
    },
    include: { vm: { select: { hostname: true } } },
  });
}
describe('real PostgreSQL tenant operations', () => {
  it('returns the first acknowledgement winner without extra events or timestamp changes', async () => {
    const row = await persistedSignal();
    const first = await repository.acknowledge(
      org,
      row.id,
      user,
      Date.now() + 5000,
    );
    expect(first).toMatchObject({
      id: row.id,
      status: 'FIRING',
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: user,
    });
    expect(first?.acknowledgedAt).toBeInstanceOf(Date);
    const repeat = await repository.acknowledge(
      org,
      row.id,
      secondUser,
      Date.now() + 5000,
    );
    expect(repeat).toEqual(first);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING', 'ACKNOWLEDGED'],
    );
  });
  it('acknowledges already-resolved OPEN without changing source state', async () => {
    const row = await persistedSignal({
      ...signal(),
      status: 'RESOLVED',
      endsAt: '2026-10-10T00:10:00.000000001Z',
    });
    const result = await repository.acknowledge(
      org,
      row.id,
      user,
      Date.now() + 5000,
    );
    expect(result).toMatchObject({
      status: 'RESOLVED',
      endsAtKey: row.endsAtKey,
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: user,
    });
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_RESOLVED', 'ACKNOWLEDGED'],
    );
  });
  it('appends duplicate text distinctly on resolved OPEN without implicitly acknowledging', async () => {
    const row = await persistedSignal({
      ...signal(),
      status: 'RESOLVED',
      endsAt: '2026-10-10T00:10:00.000000001Z',
    });
    const first = await repository.comment(
      org,
      row.id,
      user,
      'same 😀\n note',
      Date.now() + 5000,
    );
    const second = await repository.comment(
      org,
      row.id,
      user,
      'same 😀\n note',
      Date.now() + 5000,
    );
    expect(first).toMatchObject({
      type: 'COMMENT_ADDED',
      actorId: user,
      message: 'same 😀\n note',
      sequence: 2,
      sourceTimeKey: null,
    });
    expect(second).toMatchObject({ sequence: 3 });
    expect(second?.id).not.toBe(first?.id);
    expect(await repository.get(org, row.id)).toEqual(row);
  });
  it('scopes every parent/action and never returns another tenant timeline', async () => {
    const row = await persistedSignal(),
      foreignOrg = randomUUID();
    expect(await repository.get(foreignOrg, row.id)).toBeNull();
    expect(
      await repository.events(foreignOrg, row.id, { page: 1, pageSize: 50 }),
    ).toBeNull();
    expect(
      await repository.acknowledge(foreignOrg, row.id, user, Date.now() + 5000),
    ).toBeNull();
    expect(
      await repository.comment(
        foreignOrg,
        row.id,
        user,
        'not stored',
        Date.now() + 5000,
      ),
    ).toBeNull();
    expect(
      await repository.list(foreignOrg, { page: 1, pageSize: 50 }),
    ).toEqual({ rows: [], total: 0 });
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING'],
    );
  });
  it('uses identical filters for list/count and bounds ordered history pages', async () => {
    const page = await repository.list(org, {
      page: 1,
      pageSize: 1,
      signalStatus: 'RESOLVED',
      workflowStatus: 'ACKNOWLEDGED',
      severity: 'WARNING',
      vmId: vm,
    });
    const count = await database.query(
      `SELECT count(*)::int AS count FROM alerts WHERE "organizationId"=$1 AND "vmId"=$2 AND status='RESOLVED' AND "workflowStatus"='ACKNOWLEDGED' AND severity='WARNING'`,
      [org, vm],
    );
    expect(page.total).toBe(count.rows[0].count);
    expect(page.rows).toHaveLength(Math.min(1, page.total));
    expect(page.rows[0]).not.toHaveProperty('labels');
    expect(page.rows[0]).not.toHaveProperty('annotations');
    expect(page.rows[0]).toMatchObject({
      organizationId: org,
      vmId: vm,
      status: 'RESOLVED',
      workflowStatus: 'ACKNOWLEDGED',
    });
    const row = await persistedSignal();
    await repository.comment(org, row.id, user, 'one', Date.now() + 5000);
    await repository.comment(org, row.id, user, 'two', Date.now() + 5000);
    const events = await repository.events(org, row.id, {
      page: 2,
      pageSize: 1,
    });
    expect(events?.total).toBe(3);
    expect(events?.rows.map((event) => event.sequence)).toEqual([2]);
  });
  it('rolls back workflow and timestamp changes when the ACK event insert fails', async () => {
    const row = await persistedSignal();
    await database.query(
      `CREATE FUNCTION fixture_reject_ack_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='ACKNOWLEDGED' THEN RAISE EXCEPTION 'fixture ACK event failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reject_ack_event BEFORE INSERT ON alert_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_ack_event();`,
    );
    try {
      await expect(
        repository.acknowledge(org, row.id, user, Date.now() + 5000),
      ).rejects.toThrow('Alert ingestion unavailable');
      expect(await repository.get(org, row.id)).toEqual(row);
      expect(
        (await history(row.fingerprint)).map((event) => event.type),
      ).toEqual(['ALERT_FIRING']);
    } finally {
      await database.query(
        'DROP TRIGGER fixture_reject_ack_event ON alert_events; DROP FUNCTION fixture_reject_ack_event()',
      );
    }
  });
  it('rolls back actor disappearance and expired operation budgets safely', async () => {
    const row = await persistedSignal(),
      missingActor = randomUUID();
    await expect(
      repository.acknowledge(org, row.id, missingActor, Date.now() + 5000),
    ).rejects.toThrow('Alert ingestion unavailable');
    await expect(
      repository.comment(
        org,
        row.id,
        missingActor,
        'not stored',
        Date.now() + 5000,
      ),
    ).rejects.toThrow('Alert ingestion unavailable');
    await expect(
      repository.acknowledge(org, row.id, user, Date.now() - 1),
    ).rejects.toThrow('Alert ingestion unavailable');
    expect(await repository.get(org, row.id)).toEqual(row);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING'],
    );
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function coordinatedRepository(hold: boolean) {
  const attempted = gate(),
    locked = gate(),
    release = gate(),
    keys: string[] = [];
  const facade = {
    alert: prisma.alert,
    alertEvent: prisma.alertEvent,
    $transaction: <T>(
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ) =>
      prisma.$transaction(
        (tx) =>
          callback(
            new Proxy(tx, {
              get(target, property) {
                if (property !== '$queryRaw')
                  return Reflect.get(target, property);
                return async (query: Prisma.Sql) => {
                  const isLock = query.sql.includes('pg_advisory_xact_lock');
                  if (isLock) {
                    keys.push(String(query.values[0]));
                    attempted.resolve();
                  }
                  const result = await tx.$queryRaw(query);
                  if (isLock) {
                    locked.resolve();
                    if (hold) await release.promise;
                  }
                  return result;
                };
              },
            }),
          ),
        options,
      ),
  };
  return {
    repository: new AlertRepository(facade as unknown as PrismaService),
    attempted,
    locked,
    release,
    keys,
  };
}
async function reached(marker: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    marker,
    operation.then(() => {
      throw new Error('Operation completed without the intended lock barrier');
    }),
  ]);
}
describe('controlled real PostgreSQL serialization', () => {
  it('lets only the first concurrent ACK actor win with one event', async () => {
    const row = await persistedSignal(),
      first = coordinatedRepository(true),
      second = coordinatedRepository(false);
    const a = first.repository.acknowledge(
      org,
      row.id,
      user,
      Date.now() + 5000,
    );
    let b: Promise<unknown> | undefined;
    try {
      await reached(first.locked.promise, a);
      b = second.repository.acknowledge(
        org,
        row.id,
        secondUser,
        Date.now() + 5000,
      );
      await reached(second.attempted.promise, b);
      first.release.resolve();
      const results = await Promise.all([a, b]);
      expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({ acknowledgedBy: user });
    } finally {
      first.release.resolve();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING', 'ACKNOWLEDGED'],
    );
  });
  it.each(['ack-first', 'resolve-first'] as const)(
    'preserves both workflow and signal using controlled order: %s',
    async (order) => {
      const incoming = signal(),
        row = await persistedSignal(incoming),
        resolved = {
          ...incoming,
          status: 'RESOLVED' as const,
          endsAt: '2026-10-10T00:10:00.000000001Z',
        };
      const first = coordinatedRepository(true),
        second = coordinatedRepository(false);
      const a =
        order === 'ack-first'
          ? first.repository.acknowledge(org, row.id, user, Date.now() + 5000)
          : first.repository.persistBatch([resolved], Date.now() + 5000);
      let b: Promise<unknown> | undefined;
      try {
        await reached(first.locked.promise, a);
        b =
          order === 'ack-first'
            ? second.repository.persistBatch([resolved], Date.now() + 5000)
            : second.repository.acknowledge(
                org,
                row.id,
                user,
                Date.now() + 5000,
              );
        await reached(second.attempted.promise, b);
        first.release.resolve();
        await Promise.all([a, b]);
      } finally {
        first.release.resolve();
        await Promise.allSettled([a, ...(b ? [b] : [])]);
      }
      expect(first.keys).toEqual([occurrenceKey(incoming)]);
      expect(second.keys).toEqual([occurrenceKey(incoming)]);
      expect(await repository.get(org, row.id)).toMatchObject({
        status: 'RESOLVED',
        endsAtKey: resolved.endsAt,
        workflowStatus: 'ACKNOWLEDGED',
        acknowledgedBy: user,
      });
      expect(
        (await history(row.fingerprint)).map((event) => event.type),
      ).toEqual(
        order === 'ack-first'
          ? ['ALERT_FIRING', 'ACKNOWLEDGED', 'ALERT_RESOLVED']
          : ['ALERT_FIRING', 'ALERT_RESOLVED', 'ACKNOWLEDGED'],
      );
    },
  );
  it('serializes simultaneous comments/resolve with contiguous immutable recording sequence', async () => {
    const incoming = signal(),
      row = await persistedSignal(incoming);
    await Promise.all([
      repository.comment(org, row.id, user, 'same', Date.now() + 5000),
      repository.comment(org, row.id, secondUser, 'same', Date.now() + 5000),
      repository.persistBatch(
        [
          {
            ...incoming,
            status: 'RESOLVED',
            endsAt: '2026-10-10T00:10:00.000000001Z',
          },
        ],
        Date.now() + 5000,
      ),
    ]);
    const events = await history(row.fingerprint);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      events.filter((event) => event.type === 'COMMENT_ADDED'),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === 'ALERT_RESOLVED'),
    ).toHaveLength(1);
    await ingest([incoming]);
    expect(await history(row.fingerprint)).toEqual(events);
  });
  it('re-reads committed state after waiting on an external exact-key lock, not a stale snapshot', async () => {
    const incoming = signal(),
      row = await persistedSignal(incoming),
      waiter = coordinatedRepository(false);
    await database.query('BEGIN');
    await database.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [occurrenceKey(incoming)],
    );
    const operation = waiter.repository.acknowledge(
      org,
      row.id,
      secondUser,
      Date.now() + 5000,
    );
    try {
      await reached(waiter.attempted.promise, operation);
      // Controlled old-writer fixture: no event-capable production mutation is substituted here.
      await database.query(
        `UPDATE alerts SET status='RESOLVED',"endsAtKey"='2026-10-10T00:10:00.000000001Z',"endsAt"='2026-10-10T00:10:00Z',"workflowStatus"='ACKNOWLEDGED',"acknowledgedBy"=$2,"acknowledgedAt"=now() WHERE id=$1`,
        [row.id, user],
      );
      await database.query('COMMIT');
      expect(await operation).toMatchObject({
        status: 'RESOLVED',
        workflowStatus: 'ACKNOWLEDGED',
        acknowledgedBy: user,
      });
      // Returning the committed winner must not fabricate the missing old-writer ACK/RESOLVED events.
      expect(
        (await history(row.fingerprint)).map((event) => event.type),
      ).toEqual(['ALERT_FIRING']);
    } finally {
      await database.query('ROLLBACK');
      await Promise.allSettled([operation]);
    }
  });
  it('returns missing parent if deleted between preliminary lookup and lock acquisition', async () => {
    const incoming = signal(),
      row = await persistedSignal(incoming),
      waiter = coordinatedRepository(false);
    await database.query('BEGIN');
    await database.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [occurrenceKey(incoming)],
    );
    const operation = waiter.repository.comment(
      org,
      row.id,
      user,
      'not stored',
      Date.now() + 5000,
    );
    try {
      await reached(waiter.attempted.promise, operation);
      await database.query('DELETE FROM alerts WHERE id=$1', [row.id]);
      await database.query('COMMIT');
      expect(await operation).toBeNull();
      expect(await history(row.fingerprint)).toEqual([]);
    } finally {
      await database.query('ROLLBACK');
      await Promise.allSettled([operation]);
    }
  });
  it('bounds a contended operator lock without partial workflow or events', async () => {
    const incoming = signal(),
      row = await persistedSignal(incoming),
      waiter = coordinatedRepository(false);
    const before = Date.now();
    await database.query('BEGIN');
    await database.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [occurrenceKey(incoming)],
    );
    const operation = waiter.repository.acknowledge(
      org,
      row.id,
      user,
      before + 5000,
    );
    try {
      await reached(waiter.attempted.promise, operation);
      await expect(operation).rejects.toThrow('Alert ingestion unavailable');
      expect(Date.now() - before).toBeLessThan(5000);
    } finally {
      await database.query('ROLLBACK');
      await Promise.allSettled([operation]);
    }
    expect(await repository.get(org, row.id)).toEqual(row);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING'],
    );
  });
  it.each(['FIRING', 'RESOLVED'] as const)(
    'permits comments on acknowledged %s without any state change',
    async (status) => {
      const row = await persistedSignal({
        ...signal(),
        status,
        endsAt: status === 'RESOLVED' ? '2026-10-10T00:10:00.000000001Z' : null,
      });
      const acknowledged = await repository.acknowledge(
        org,
        row.id,
        user,
        Date.now() + 5000,
      );
      await repository.comment(org, row.id, user, 'note', Date.now() + 5000);
      expect(await repository.get(org, row.id)).toEqual(acknowledged);
    },
  );
  it('starts legacy/old-writer history with only observed comment/ACK, not an invented firing', async () => {
    const incoming = signal();
    const row = await prisma.alert.create({
      data: {
        source: incoming.source,
        organizationId: org,
        vmId: vm,
        fingerprint: incoming.fingerprint,
        alertName: incoming.alertName,
        severity: incoming.severity,
        status: 'FIRING',
        startsAt: new Date(incoming.startsAt),
        startsAtKey: incoming.startsAt,
        labels: incoming.labels,
        annotations: incoming.annotations,
      },
    });
    expect(await history(row.fingerprint)).toEqual([]);
    await repository.comment(
      org,
      row.id,
      user,
      'first observed action',
      Date.now() + 5000,
    );
    await repository.acknowledge(org, row.id, user, Date.now() + 5000);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['COMMENT_ADDED', 'ACKNOWLEDGED'],
    );
    await database.query(
      `UPDATE alerts SET status='RESOLVED',"endsAtKey"='2026-10-10T00:10:00.000000001Z',"endsAt"='2026-10-10T00:10:00Z' WHERE id=$1`,
      [row.id],
    );
    await ingest([
      {
        ...incoming,
        status: 'RESOLVED',
        endsAt: '2026-10-10T00:10:00.000000001Z',
      },
    ]);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['COMMENT_ADDED', 'ACKNOWLEDGED'],
    );
  });
  it('rolls back when an actor disappears after the bounded preliminary lookup', async () => {
    const incoming = signal(),
      row = await persistedSignal(incoming),
      actor = randomUUID(),
      waiter = coordinatedRepository(false);
    await database.query(
      `INSERT INTO "User" (id,"cognitoSub",email,"updatedAt") VALUES ($1,$2,$3,now())`,
      [actor, `disposable-${actor}`, `${actor}@example.invalid`],
    );
    await database.query('BEGIN');
    await database.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [occurrenceKey(incoming)],
    );
    const operation = waiter.repository.acknowledge(
      org,
      row.id,
      actor,
      Date.now() + 5000,
    );
    try {
      await reached(waiter.attempted.promise, operation);
      await database.query('DELETE FROM "User" WHERE id=$1', [actor]);
      await database.query('COMMIT');
      await expect(operation).rejects.toThrow('Alert ingestion unavailable');
    } finally {
      await database.query('ROLLBACK');
      await Promise.allSettled([operation]);
    }
    expect(await repository.get(org, row.id)).toEqual(row);
    expect((await history(row.fingerprint)).map((event) => event.type)).toEqual(
      ['ALERT_FIRING'],
    );
  });
  it('breaks list timestamp ties deterministically by id descending', async () => {
    const rows = await Promise.all([
      persistedSignal(),
      persistedSignal(),
      persistedSignal(),
    ]);
    for (const row of rows)
      await database.query(
        `UPDATE alerts SET "createdAt"='2099-01-01T00:00:00Z' WHERE id=$1`,
        [row.id],
      );
    const expected = rows
      .map((row) => row.id)
      .sort()
      .reverse();
    expect(
      (await repository.list(org, { page: 1, pageSize: 3 })).rows.map(
        (row) => row.id,
      ),
    ).toEqual(expected);
    expect(
      (await repository.list(org, { page: 2, pageSize: 2 })).rows[0].id,
    ).toBe(expected[2]);
  });
});

describe('real PostgreSQL alert UI list contract', () => {
  const listOrg = '88888888-8888-4888-8888-888888888888';
  const listVm = '99999999-9999-4999-8999-999999999999';
  const foreignListOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreignListVm = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let ids: {
    criticalOlder: string;
    criticalNewer: string;
    warningNewer: string;
    warningOlder: string;
  };
  beforeAll(async () => {
    for (const [tenant, machine] of [
      [listOrg, listVm],
      [foreignListOrg, foreignListVm],
    ]) {
      await database.query(
        'INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$2,$2,now())',
        [tenant, `list-${tenant}`],
      );
      await database.query(
        'INSERT INTO "Vm" (id,"organizationId",hostname,"updatedAt") VALUES ($1,$2,$3,now())',
        [machine, tenant, 'Edge_%\\host'],
      );
    }
    const create = async (
      fingerprint: string,
      startsAt: string,
      severity: 'WARNING' | 'CRITICAL',
      tenant = listOrg,
      machine = listVm,
    ) => {
      const alertName =
        severity === 'CRITICAL' ? 'VMDisconnected' : 'VMHighCPU';
      const incoming: CanonicalAlertEvent = {
        ...signal(fingerprint, startsAt),
        organizationId: tenant,
        vmId: machine,
        severity,
        alertName,
        labels: {
          organization_id: tenant,
          vm_id: machine,
          alertname: alertName,
          severity: severity.toLowerCase(),
        },
      };
      await ingest([incoming]);
      const result = await repository.list(tenant, { page: 1, pageSize: 100 });
      return result.rows.find((row) => row.fingerprint === fingerprint)!.id;
    };
    ids = {
      criticalOlder: await create(
        'list-critical-older',
        '2026-10-10T00:00:00.123456789Z',
        'CRITICAL',
      ),
      criticalNewer: await create(
        'list-critical-newer',
        '2026-10-10T00:00:00.123456790Z',
        'CRITICAL',
      ),
      warningNewer: await create(
        'list-warning-newer',
        '2035-10-10T00:00:00.000000001Z',
        'WARNING',
      ),
      warningOlder: await create(
        'list-warning-older',
        '2000-10-10T00:00:00.000000001Z',
        'WARNING',
      ),
    };
    await create(
      'list-foreign',
      '2099-10-10T00:00:00.000000001Z',
      'CRITICAL',
      foreignListOrg,
      foreignListVm,
    );
  });
  it('sorts the whole tenant dataset by critical severity before pagination and counts exactly that tenant', async () => {
    const first = await repository.list(listOrg, {
      page: 1,
      pageSize: 2,
      sort: 'severity_desc',
    });
    expect(first.total).toBe(4);
    expect(first.rows.map((row) => row.id)).toEqual([
      ids.criticalNewer,
      ids.criticalOlder,
    ]);
    const second = await repository.list(listOrg, {
      page: 2,
      pageSize: 2,
      sort: 'severity_desc',
    });
    expect(second.rows.map((row) => row.id)).toEqual([
      ids.warningNewer,
      ids.warningOlder,
    ]);
  });
  it('orders canonical source-time nanoseconds in either direction independently of receipt time', async () => {
    const desc = await repository.list(listOrg, {
      page: 1,
      pageSize: 50,
      sort: 'started_at_desc',
    });
    expect(desc.rows.map((row) => row.id)).toEqual([
      ids.warningNewer,
      ids.criticalNewer,
      ids.criticalOlder,
      ids.warningOlder,
    ]);
    const asc = await repository.list(listOrg, {
      page: 1,
      pageSize: 50,
      sort: 'started_at_asc',
    });
    expect(asc.rows.map((row) => row.id)).toEqual([
      ids.warningOlder,
      ids.criticalOlder,
      ids.criticalNewer,
      ids.warningNewer,
    ]);
  });
  it('performs case-insensitive name or related hostname search with the same scoped count predicate', async () => {
    const byName = await repository.list(listOrg, {
      page: 1,
      pageSize: 1,
      q: 'vMhIgH',
    });
    expect(byName.total).toBe(2);
    const byHost = await repository.list(listOrg, {
      page: 1,
      pageSize: 2,
      q: 'edge_%\\host',
    });
    expect(byHost.total).toBe(4);
    expect(byHost.rows).toHaveLength(2);
    expect(byHost.rows.every((row) => row.organizationId === listOrg)).toBe(
      true,
    );
  });
  it('treats percent, underscore and backslash as literals rather than SQL search wildcards', async () => {
    for (const q of ['VMHigh%', 'Edge__']) {
      const result = await repository.list(listOrg, {
        page: 1,
        pageSize: 50,
        q,
      });
      expect(result).toEqual({ rows: [], total: 0 });
    }
    expect(
      (await repository.list(listOrg, { page: 1, pageSize: 50, q: '\\host' }))
        .total,
    ).toBe(4);
  });
  it('uses a bounded hostname projection for list/detail and first or repeated acknowledgement', async () => {
    const result = await repository.list(listOrg, { page: 1, pageSize: 50 });
    expect(result.rows.map((row) => row.vm)).toEqual(
      Array.from({ length: 4 }, () => ({ hostname: 'Edge_%\\host' })),
    );
    expect(result.rows[0]).not.toHaveProperty('labels');
    expect(result.rows[0]).not.toHaveProperty('annotations');
    expect((await repository.get(listOrg, ids.criticalOlder))?.vm).toEqual({
      hostname: 'Edge_%\\host',
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await repository.acknowledge(
            listOrg,
            ids.criticalOlder,
            user,
            Date.now() + 5000,
          )
        )?.vm,
      ).toEqual({ hostname: 'Edge_%\\host' });
    expect(await repository.get(foreignListOrg, ids.criticalOlder)).toBeNull();
  });
});
