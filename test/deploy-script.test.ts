import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Tests run from the compiled dist/ tree (dist/test/...), so walk up to the
// repository root by locating the directory that actually contains scripts/.
function findRepoRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(current, 'scripts/deploy.sh'))) return current;
    current = dirname(current);
  }
  throw new Error('could not locate repo root containing scripts/deploy.sh');
}
const repoRoot = findRepoRoot(here);
const scriptPath = resolve(repoRoot, 'scripts/deploy.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Run the deploy script in read-only modes only. We never invoke `start`, so
// the test can never spawn a long-running server.
function runDeploy(args: readonly string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

void test('deploy.sh --help prints usage and exits 0', () => {
  const result = runDeploy(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Agentlink deploy helper/);
  assert.match(result.stdout, /print-command/);
  assert.match(result.stdout, /Node\.js >= 22/);
});

void test('deploy.sh source contains the required production env guards', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /set -euo pipefail/);
  assert.match(source, /AGENTLINK_STORAGE=postgres requires AGENTLINK_DATABASE_URL/);
  assert.match(source, /NODE_ENV=production requires AGENTLINK_SOURCE_HASH_SECRET/);
  assert.match(source, /NODE_ENV=production requires AGENTLINK_INGRESS_BEARER_TOKEN/);
  // Migrations must be opt-in only.
  assert.match(source, /AGENTLINK_DEPLOY_APPLY_MIGRATION/);
});

void test('deploy.sh print-command does not start the server and prints redacted summary', () => {
  const result = runDeploy(['print-command'], { AGENTLINK_STORAGE: 'memory' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolved startup command: npm start/);
  assert.match(result.stderr, /config summary/);
  // No build/install/start side effects are logged.
  assert.doesNotMatch(result.stderr, /Starting server/);
  assert.doesNotMatch(result.stderr, /Installing dependencies/);
});

void test('deploy.sh --dry-run overrides start/check modes and never prepares', () => {
  const result = runDeploy(['check', '--dry-run'], { AGENTLINK_STORAGE: 'memory' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolved startup command: npm start/);
  assert.doesNotMatch(result.stderr, /check complete/);
  assert.doesNotMatch(result.stderr, /Installing dependencies/);
  assert.doesNotMatch(result.stderr, /Starting server/);
});

void test('deploy.sh fails fast when postgres storage lacks a database url', () => {
  const result = runDeploy(['print-command'], { AGENTLINK_STORAGE: 'postgres' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTLINK_STORAGE=postgres requires AGENTLINK_DATABASE_URL/);
});

void test('deploy.sh fails fast when production lacks required secrets', () => {
  const result = runDeploy(['print-command'], { NODE_ENV: 'production' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NODE_ENV=production requires AGENTLINK_SOURCE_HASH_SECRET/);
});

void test('deploy.sh never prints secret values in the config summary', () => {
  const result = runDeploy(['print-command'], {
    NODE_ENV: 'production',
    AGENTLINK_STORAGE: 'postgres',
    AGENTLINK_DATABASE_URL: 'postgres://user:leak-pw@host/db',
    AGENTLINK_SOURCE_HASH_SECRET: 'leak-hash-secret',
    AGENTLINK_INGRESS_BEARER_TOKEN: 'leak-bearer-token',
  });
  assert.equal(result.status, 0);
  const combined = result.stdout + result.stderr;
  assert.doesNotMatch(combined, /leak-pw/);
  assert.doesNotMatch(combined, /leak-hash-secret/);
  assert.doesNotMatch(combined, /leak-bearer-token/);
  assert.match(result.stderr, /set \(redacted\)/);
});
