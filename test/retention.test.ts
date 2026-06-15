import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETENTION_CLASSES,
  SENSITIVITIES,
  DEFAULT_MEMORY_SPACE,
  DEFAULT_SOURCE_SYSTEM,
  AGENTLET_SOURCE_SYSTEM,
  RETENTION_IDENTIFIER_PATTERN,
  RetentionMetadataError,
  TASK_RETENTION_DEFAULTS,
  EVENT_RETENTION_DEFAULTS,
  MAIN_USER_RETENTION_DEFAULTS,
  CHANNEL_USER_RETENTION_DEFAULTS,
  PLATFORM_IDENTITY_RETENTION_DEFAULTS,
  GROUP_PROFILE_RETENTION_DEFAULTS,
  SOURCE_EVENT_RETENTION_DEFAULTS,
  ENTRY_RETENTION_DEFAULTS,
  isRetentionClass,
  isSensitivity,
  isRetentionIdentifier,
  normalizeRetentionMetadata,
  withoutRawRetention,
} from '../src/domain/retention.js';

void test('retention vocabulary has expected values', () => {
  assert.deepEqual([...RETENTION_CLASSES], ['short_term', 'operational', 'artifact', 'audit', 'memory_candidate', 'memory']);
  assert.deepEqual([...SENSITIVITIES], ['public', 'internal', 'confidential', 'secret']);
  assert.equal(DEFAULT_MEMORY_SPACE, 'default');
  assert.equal(DEFAULT_SOURCE_SYSTEM, 'agentlink');
  assert.equal(AGENTLET_SOURCE_SYSTEM, 'agentlet');
});

void test('isRetentionClass accepts valid and rejects invalid', () => {
  for (const value of RETENTION_CLASSES) assert.equal(isRetentionClass(value), true);
  assert.equal(isRetentionClass('unknown'), false);
  assert.equal(isRetentionClass(''), false);
  assert.equal(isRetentionClass(null), false);
  assert.equal(isRetentionClass(undefined), false);
  assert.equal(isRetentionClass(123), false);
});

void test('isSensitivity accepts valid and rejects invalid', () => {
  for (const value of SENSITIVITIES) assert.equal(isSensitivity(value), true);
  assert.equal(isSensitivity('top_secret'), false);
  assert.equal(isSensitivity(''), false);
});

void test('isRetentionIdentifier matches the documented pattern', () => {
  assert.equal(isRetentionIdentifier('default'), true);
  assert.equal(isRetentionIdentifier('my.memory-space:v1'), true);
  assert.equal(isRetentionIdentifier('A-z0.9_:-'), true);
  assert.equal(isRetentionIdentifier(''), false);
  assert.equal(isRetentionIdentifier(' space'), false);
  assert.equal(isRetentionIdentifier('name with spaces'), false);
  assert.equal(isRetentionIdentifier("x'.sql"), false);
  assert.equal(isRetentionIdentifier('a'.repeat(128)), true);
  assert.equal(isRetentionIdentifier('a'.repeat(129)), false);
  assert.equal(RETENTION_IDENTIFIER_PATTERN.test(''), false);
});

void test('normalizeRetentionMetadata fills defaults for task', () => {
  const result = normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS);
  assert.equal(result.retentionClass, 'operational');
  assert.equal(result.sensitivity, 'internal');
  assert.equal(result.memorySpace, 'default');
  assert.equal(result.sourceSystem, 'agentlink');
});

void test('normalizeRetentionMetadata fills defaults for event', () => {
  const result = normalizeRetentionMetadata(undefined, EVENT_RETENTION_DEFAULTS);
  assert.equal(result.retentionClass, 'short_term');
  assert.equal(result.sensitivity, 'internal');
  assert.equal(result.memorySpace, 'default');
  assert.equal(result.sourceSystem, 'agentlet');
});

void test('normalizeRetentionMetadata accepts explicit overrides', () => {
  const result = normalizeRetentionMetadata(
    {
      retentionClass: 'memory_candidate',
      sensitivity: 'confidential',
      memorySpace: 'work.projectX',
      sourceSystem: 'telegram',
    },
    TASK_RETENTION_DEFAULTS,
  );
  assert.equal(result.retentionClass, 'memory_candidate');
  assert.equal(result.sensitivity, 'confidential');
  assert.equal(result.memorySpace, 'work.projectX');
  assert.equal(result.sourceSystem, 'telegram');
});

void test('normalizeRetentionMetadata rejects invalid retention_class', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ retentionClass: 'bogus' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'retention_class');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects invalid sensitivity', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ sensitivity: 'top_secret' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'sensitivity');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects empty memory_space', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ memorySpace: '' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'memory_space');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects memory_space with illegal chars', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ memorySpace: 'has space' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'memory_space');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects too-long source_system', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ sourceSystem: 'a'.repeat(129) }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'source_system');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects empty source_system', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ sourceSystem: '' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'source_system');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects source_system with illegal chars', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ sourceSystem: 'has space' }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'source_system');
      return true;
    },
  );
});

void test('normalizeRetentionMetadata rejects too-long memory_space', () => {
  assert.throws(
    () => normalizeRetentionMetadata({ memorySpace: 'a'.repeat(129) }, TASK_RETENTION_DEFAULTS),
    (error: unknown) => {
      assert.ok(error instanceof RetentionMetadataError);
      assert.equal((error as RetentionMetadataError).field, 'memory_space');
      return true;
    },
  );
});

void test('withoutRawRetention strips raw retention from input', () => {
  const input = { source: 'telegram', sourceRef: 'msg:1', retention: { retentionClass: 'memory' } };
  const result = withoutRawRetention(input);
  assert.equal((result as Record<string, unknown>).retention, undefined);
  assert.equal(result.source, 'telegram');
  assert.equal(result.sourceRef, 'msg:1');
});

void test('withoutRawRetention works when retention is absent', () => {
  const input = { source: 'telegram', sourceRef: 'msg:1', retention: undefined } as const;
  const result = withoutRawRetention(input);
  assert.equal((result as Record<string, unknown>).retention, undefined);
  assert.equal(result.source, 'telegram');
  assert.equal(result.sourceRef, 'msg:1');
});

void test('omitting retention produces same normalized form as explicit defaults', () => {
  const a = normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS);
  const b = normalizeRetentionMetadata(
    {
      retentionClass: 'operational',
      sensitivity: 'internal',
      memorySpace: 'default',
      sourceSystem: 'agentlink',
    },
    TASK_RETENTION_DEFAULTS,
  );
  assert.deepEqual(a, b);
});

void test('MAIN_USER_RETENTION_DEFAULTS use operational/default/agentlink/internal', () => {
  const d = MAIN_USER_RETENTION_DEFAULTS;
  assert.equal(d.retentionClass, 'operational');
  assert.equal(d.memorySpace, 'default');
  assert.equal(d.sourceSystem, 'agentlink');
  assert.equal(d.sensitivity, 'internal');
});

void test('AL-M1-004/005 identity and group retention defaults use operational/default/agentlink/internal', () => {
  for (const d of [CHANNEL_USER_RETENTION_DEFAULTS, PLATFORM_IDENTITY_RETENTION_DEFAULTS, GROUP_PROFILE_RETENTION_DEFAULTS]) {
    assert.equal(d.retentionClass, 'operational');
    assert.equal(d.memorySpace, 'default');
    assert.equal(d.sourceSystem, 'agentlink');
    assert.equal(d.sensitivity, 'internal');
  }
});

void test('normalizeRetentionMetadata with MAIN_USER defaults produces consistent output', () => {
  const a = normalizeRetentionMetadata(undefined, MAIN_USER_RETENTION_DEFAULTS);
  const b = normalizeRetentionMetadata(
    { retentionClass: 'operational', memorySpace: 'default', sourceSystem: 'agentlink', sensitivity: 'internal' },
    MAIN_USER_RETENTION_DEFAULTS,
  );
  assert.deepEqual(a, b);
  assert.equal(a.retentionClass, 'operational');
  assert.equal(a.memorySpace, 'default');
});


void test('AL-M1-006 ingress retention defaults use short_term/default/agentlink/internal before source override', () => {
  for (const d of [SOURCE_EVENT_RETENTION_DEFAULTS, ENTRY_RETENTION_DEFAULTS]) {
    assert.equal(d.retentionClass, 'short_term');
    assert.equal(d.memorySpace, 'default');
    assert.equal(d.sourceSystem, 'agentlink');
    assert.equal(d.sensitivity, 'internal');
  }
});
