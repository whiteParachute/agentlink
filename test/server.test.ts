import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentlinkServer } from '../src/server.js';

test('health endpoint returns service metadata', async () => {
  const server = createAgentlinkServer({ name: 'agentlink-test', version: '0.1.0-test', environment: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);

  try {
    const port = (address as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; service: string; version: string };
    assert.deepEqual(body, { ok: true, service: 'agentlink-test', version: '0.1.0-test' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
