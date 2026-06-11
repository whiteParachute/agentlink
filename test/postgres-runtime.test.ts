import test from 'node:test';
import assert from 'node:assert/strict';
import { PgRuntime, type PgPoolClientLike } from '../src/db/pg-client.js';
import { withPostgreSqlRepository } from '../src/db/postgres-runtime.js';

class FakePoolClient implements PgPoolClientLike {
  released = false;

  async query() {
    return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  }

  release(): void {
    this.released = true;
  }
}

test('withPostgreSqlRepository binds the repository to one checked-out pg client', async () => {
  const client = new FakePoolClient();
  const runtime = new PgRuntime({
    async connect() {
      return client;
    },
    async end() {},
  });

  const result = await withPostgreSqlRepository(runtime, async (repository) => repository.constructor.name);

  assert.equal(result, 'PostgreSqlRepository');
  assert.equal(client.released, true);
});
