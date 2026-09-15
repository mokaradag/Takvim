import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const require = createRequire(import.meta.url);
require('mssql');
const nativePath = require.resolve('msnodesqlv8');
const native = {};
require.cache[nativePath] = { id: nativePath, filename: nativePath, loaded: true, exports: native };
const driver = require('mssql/msnodesqlv8.js');
delete require.cache[nativePath];
const { runOutlookCalendarOutbox } = await import('../src/server/outlook/outlookCalendarService.js');
const { revalidateOutlookSubscriptions, claimOutlookDeliveries } = await import('../src/server/outlook/outlookStore.js');
const { abortableOutlookOperation } = await import('../src/server/outlook/outlookExecution.js');

// Yalnız yerel taşıma taklittir; havuz, tip bağlama ve işlem sınıfları gerçek mssql'dir.
async function stack(t) {
  const env = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: 'mail.test.internal', SMTP_FROM: 'rota@example.internal' });
  const session = { isolation: 'READ COMMITTED', commands: [], failure: null, hanging: false, cancels: 0 };
  native.open = (config, callback) => callback(null, {
    setUseNumericString() {}, setUseUTC() {},
    close: (done) => done(),
    query: (text, done) => done(null, [{ value: 1 }]),
    queryRaw(command, parameters) {
      session.commands.push({ text: command.query_str, parameters });
      const query = new EventEmitter();
      query.isPaused = () => false;
      query.cancelQuery = (done) => {
        session.cancels += 1;
        setImmediate(() => {
          query.emit('error', Object.assign(new Error('Operation canceled'), { code: 0, sqlstate: 'HY008' }), false);
          query.emit('done');
          done();
        });
      };
      setImmediate(() => {
        if (session.hanging) { session.hanging = false; return; }
        const text = command.query_str;
        const isolation = /set transaction isolation level (READ COMMITTED|SERIALIZABLE)/i.exec(text);
        if (isolation) session.isolation = isolation[1].toUpperCase();
        const failure = session.failure || (/\bREADPAST\b/i.test(text) && session.isolation === 'SERIALIZABLE'
          ? Object.assign(new Error('READPAST requires READ COMMITTED or REPEATABLE READ.'), { code: 650, sqlstate: '42000', severity: 16 }) : null);
        session.failure = null;
        if (failure) query.emit('error', failure, false);
        else if (/AS Exhausted/i.test(text)) {
          query.emit('meta', [{ name: 'Exhausted', sqlType: 'bigint', nullable: false }]);
          query.emit('row', 0);
          query.emit('column', 0, '0', false);
        } else if (/OUTPUT inserted/i.test(text)) {
          query.emit('meta', [{ name: 'SubscriptionId', sqlType: 'bigint', nullable: false }]);
        } else query.emit('rowcount', 0);
        query.emit('done');
      });
      return query;
    }
  });
  const pool = await new driver.ConnectionPool({
    server: 'test', database: 'test', pool: { min: 0, max: 1 }, options: { trustedConnection: true }
  }).connect();
  t.after(async () => {
    await pool.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  return { pool, session };
}

for (const end of ['commit', 'rollback']) {
  test(`gerçek mssql ${end} sonrası devralınan SERIALIZABLE boş Outlook turunu bozmaz`, async (t) => {
    const { pool, session } = await stack(t);
    const transaction = new driver.Transaction(pool);
    await transaction.begin(driver.ISOLATION_LEVEL.SERIALIZABLE);
    await transaction[end]();
    assert.equal(session.isolation, 'SERIALIZABLE');
    const result = await runOutlookCalendarOutbox(pool);
    assert.equal(result.ok, true);
    assert.equal(result.claimed, 0);
    assert.equal(result.failed, 0);
    const revalidate = session.commands.find(({ text }) => /WITH unchecked/.test(text));
    assert.match(revalidate.text, /declare @limit int;set @limit=\?/i);
    assert.deepEqual(revalidate.parameters, [25]);
    const claim = session.commands.find(({ text }) => /WITH due/.test(text));
    assert.match(claim.text, /@leaseToken uniqueidentifier/i);
    assert.equal(claim.parameters.length, 4);
  });
}

for (const operation of [
  (pool) => revalidateOutlookSubscriptions(pool, 25),
  (pool) => claimOutlookDeliveries(pool, { limit: 1, maxAttempts: 6 })
]) {
  test('her READPAST sorgusu kendi ödünç aldığı oturumda çalışır', async (t) => {
    const { pool, session } = await stack(t);
    const transaction = new driver.Transaction(pool);
    await transaction.begin(driver.ISOLATION_LEVEL.SERIALIZABLE);
    await transaction.commit();
    assert.equal(session.isolation, 'SERIALIZABLE');
    await operation(pool);
  });
}

for (const [metadata, reason] of [
  [{ code: 0, sqlstate: 'HYT00' }, 'DATABASE_TIMEOUT'],
  [{ code: 1205, sqlstate: '40001', severity: 13 }, 'DATABASE_DEADLOCK'],
  [{ code: 0, sqlstate: '08003' }, 'DATABASE_UNAVAILABLE'],
  [{ code: 0, sqlstate: 'HY008' }, 'DATABASE_QUERY_FAILED']
]) {
  test(`yerel ${metadata.sqlstate} hatası doğru sınıflanır ve sonraki tur çalışır`, async (t) => {
    const { pool, session } = await stack(t);
    t.mock.method(console, 'error', () => {});
    session.failure = Object.assign(new Error('private native error'), metadata);
    const failed = await runOutlookCalendarOutbox(pool);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, reason);
    assert.equal(failed.failureStage, 'revalidate');
    const diagnostic = console.error.mock.calls[0].arguments[1];
    assert.equal(diagnostic.driverCode, 'EREQUEST');
    assert.equal(diagnostic.sqlState, metadata.sqlstate);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private/);
    assert.equal((await runOutlookCalendarOutbox(pool)).ok, true);
  });
}

test('iptal edilen gerçek mssql isteği sonrası aynı havuzda sonraki tur başarılıdır', async (t) => {
  const { pool, session } = await stack(t);
  t.mock.method(console, 'error', () => {});
  session.hanging = true;
  const failed = await runOutlookCalendarOutbox(pool, { budgetMs: 100 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'OUTLOOK_RUN_TIMEOUT');
  assert.equal(failed.failureStage, 'revalidate');
  assert.equal(session.cancels, 1);
  const recovered = await runOutlookCalendarOutbox(pool);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.claimed, 0);
  assert.equal(pool.borrowed, 0);
});

test('başlamadan iptal edilen işlem çalıştırılmaz', async () => {
  const controller = new AbortController();
  let started = false;
  const result = abortableOutlookOperation(() => { started = true; }, controller.signal);
  const reason = new Error('OUTLOOK_RUN_TIMEOUT');
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(started, false);
});

test('eşzamanlı ECANCEL veya cancel istisnası asıl süre aşımını ezmez', async () => {
  for (const throws of [false, true]) {
    const controller = new AbortController();
    let rejectQuery;
    const query = new Promise((resolve, reject) => { rejectQuery = reject; });
    const result = abortableOutlookOperation(() => query, controller.signal, () => {
      const error = Object.assign(new Error('native cancel'), { code: 'ECANCEL' });
      rejectQuery(error);
      if (throws) throw error;
    });
    await Promise.resolve();
    const reason = new Error('OUTLOOK_RUN_TIMEOUT');
    controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
  }
});
