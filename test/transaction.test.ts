import test from 'node:test';
import assert from 'node:assert/strict';
import { RollbackFailureError, withTransaction, type SqlClient, type SqlQueryResult } from '../src/db/transaction.js';

class FakeSqlClient implements SqlClient {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  failOnSql?: string;

  async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push(params ? { sql, params } : { sql });
    if (this.failOnSql && sql === this.failOnSql) {
      throw new Error(`forced failure: ${sql}`);
    }
    return { rows: [], rowCount: 0 };
  }
}

test('withTransaction commits successful work in order', async () => {
  const client = new FakeSqlClient();
  const result = await withTransaction(client, async (tx) => {
    await tx.query('SELECT $1::text', ['ok']);
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', 'SELECT $1::text', 'COMMIT']);
  assert.deepEqual(client.calls[1]?.params, ['ok']);
});

test('withTransaction rolls back failed work and rethrows original error', async () => {
  const client = new FakeSqlClient();
  const failure = new Error('work failed');

  await assert.rejects(
    withTransaction(client, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );

  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', 'ROLLBACK']);
});

test('withTransaction surfaces rollback failure with both error handles', async () => {
  const client = new FakeSqlClient();
  client.failOnSql = 'ROLLBACK';
  const failure = new Error('work failed');

  await assert.rejects(
    withTransaction(client, async () => {
      throw failure;
    }),
    (error) => error instanceof RollbackFailureError && error.originalError === failure && error.rollbackError instanceof Error,
  );

  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', 'ROLLBACK']);
});
