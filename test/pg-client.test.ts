import test from 'node:test';
import assert from 'node:assert/strict';
import { PgRuntime, PgSqlClient, type PgPoolClientLike, type PgQueryable } from '../src/db/pg-client.js';

class FakePgQueryable implements PgQueryable {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];

  constructor(private readonly rowCount: number | null) {}

  async query(sql: string, params?: readonly unknown[]) {
    this.calls.push(params ? { sql, params } : { sql });
    return { rows: [{ ok: true }], rowCount: this.rowCount, command: 'SELECT', oid: 0, fields: [] };
  }
}

class FakePoolClient extends FakePgQueryable implements PgPoolClientLike {
  released = false;

  release(): void {
    this.released = true;
  }
}

test('PgSqlClient adapts pg query results to SqlClient rowCount semantics', async () => {
  const queryable = new FakePgQueryable(null);
  const client = new PgSqlClient(queryable);

  const result = await client.query<{ ok: boolean }>('SELECT $1::text AS ok', ['yes']);

  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(queryable.calls, [{ sql: 'SELECT $1::text AS ok', params: ['yes'] }]);
});

test('PgRuntime checks out exactly one client and releases it after work', async () => {
  const client = new FakePoolClient(1);
  const pool = {
    connectCalls: 0,
    endCalls: 0,
    async connect() {
      this.connectCalls += 1;
      return client;
    },
    async end() {
      this.endCalls += 1;
    },
  };
  const runtime = new PgRuntime(pool);

  const result = await runtime.withClient(async (sqlClient) => {
    await sqlClient.query('BEGIN');
    return 'done';
  });
  await runtime.close();

  assert.equal(result, 'done');
  assert.equal(pool.connectCalls, 1);
  assert.equal(pool.endCalls, 1);
  assert.equal(client.released, true);
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN']);
});

test('PgRuntime releases checked-out clients when work fails', async () => {
  const client = new FakePoolClient(1);
  const runtime = new PgRuntime({
    async connect() {
      return client;
    },
    async end() {},
  });
  const failure = new Error('boom');

  await assert.rejects(
    runtime.withClient(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(client.released, true);
});
