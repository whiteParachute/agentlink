import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStaticPolicy, isWorkdirCovered } from '../src/domain/policy.js';

const baseInput = {
  domain: 'personal' as const,
  device: { id: 'device-1', networkScope: 'personal' },
  runner: { id: 'runner-1', capabilities: ['codex:exec'] },
  requestedCapabilities: ['codex:exec'],
  requestedNetworkScope: 'personal',
  workspace: '/repo/project',
  workdirAccess: 'read_write' as const,
  capabilityGrants: [
    {
      id: 'cap-grant-1',
      domain: 'personal' as const,
      deviceId: 'device-1',
      runnerId: 'runner-1',
      capability: 'codex:exec',
      grantStatus: 'GRANTED' as const,
      grantedBy: 'test',
      grantedAt: '2026-06-11T00:00:00.000Z',
    },
  ],
  workdirGrants: [
    {
      id: 'workdir-grant-1',
      domain: 'personal' as const,
      deviceId: 'device-1',
      pathPrefix: '/repo',
      accessMode: 'read_write' as const,
      createdAt: '2026-06-11T00:00:00.000Z',
    },
  ],
};

test('static policy allows only explicit capability and workdir grants', () => {
  assert.equal(evaluateStaticPolicy(baseInput).decision, 'ALLOW');
  assert.equal(evaluateStaticPolicy({ ...baseInput, capabilityGrants: [] }).code, 'AL_CAPABILITY_DENIED');
  assert.equal(evaluateStaticPolicy({ ...baseInput, workdirGrants: [] }).code, 'AL_WORKDIR_DENIED');
});

test('static policy enforces domain and network_scope before grant checks', () => {
  assert.equal(evaluateStaticPolicy({ ...baseInput, requestedNetworkScope: 'work' }).code, 'AL_NETWORK_SCOPE_DENIED');
});

test('workdir coverage is prefix-aware and rejects relative paths', () => {
  assert.equal(isWorkdirCovered('/repo', '/repo/project'), true);
  assert.equal(isWorkdirCovered('/repo', '/repo2/project'), false);
  assert.equal(isWorkdirCovered('repo', '/repo/project'), false);
  assert.equal(isWorkdirCovered('/repo', 'repo/project'), false);
});
