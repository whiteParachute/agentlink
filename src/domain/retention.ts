// AL-M1-002 retention metadata baseline.
//
// memory-first M1 does not forbid raw message content from appearing in
// payload / result / event bodies. Instead, every long-lived persistent object
// must carry explicit retention boundary metadata so that retention,
// memory-space attribution, source-system provenance, and sensitivity become
// queryable and testable. This module is the single source of truth for the
// retention vocabulary and normalization; it does not implement MemoryBridge,
// work/personal interop, or any cross-domain flow.

export const RETENTION_CLASSES = [
  'short_term',
  'operational',
  'artifact',
  'audit',
  'memory_candidate',
  'memory',
] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const SENSITIVITIES = ['public', 'internal', 'confidential', 'secret'] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export interface RetentionMetadata {
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
}

export interface RetentionMetadataInput {
  retentionClass?: string;
  memorySpace?: string;
  sourceSystem?: string;
  sensitivity?: string;
}

export const DEFAULT_MEMORY_SPACE = 'default';
export const DEFAULT_SOURCE_SYSTEM = 'agentlink';
export const AGENTLET_SOURCE_SYSTEM = 'agentlet';

// Identifiers are stored in CHECK-constrained text columns. Keep them to a
// conservative, injection-safe shape: lowercase-friendly tokens separated by
// '.', '-', '_', or ':'. The regex is mirrored by the SQL CHECK constraints.
export const RETENTION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === 'string' && (RETENTION_CLASSES as readonly string[]).includes(value);
}

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === 'string' && (SENSITIVITIES as readonly string[]).includes(value);
}

export function isRetentionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && RETENTION_IDENTIFIER_PATTERN.test(value);
}

export interface RetentionDefaults {
  retentionClass: RetentionClass;
  sensitivity?: Sensitivity;
  memorySpace?: string;
  sourceSystem?: string;
}

export interface RetentionValidationError {
  field: 'retention_class' | 'memory_space' | 'source_system' | 'sensitivity';
  message: string;
}

export class RetentionMetadataError extends Error {
  constructor(public readonly field: RetentionValidationError['field'], message: string) {
    super(message);
    this.name = 'RetentionMetadataError';
  }
}

// normalizeRetentionMetadata fills any missing field from defaults and validates
// every resolved field. It throws RetentionMetadataError on invalid input so
// callers (control plane, server) can translate it into a typed 400. It never
// reads or mutates raw message content.
export function normalizeRetentionMetadata(
  input: RetentionMetadataInput | undefined,
  defaults: RetentionDefaults,
): RetentionMetadata {
  const retentionClassRaw = input?.retentionClass ?? defaults.retentionClass;
  if (!isRetentionClass(retentionClassRaw)) {
    throw new RetentionMetadataError('retention_class', `retention_class must be one of ${RETENTION_CLASSES.join(', ')}`);
  }

  const sensitivityRaw = input?.sensitivity ?? defaults.sensitivity ?? 'internal';
  if (!isSensitivity(sensitivityRaw)) {
    throw new RetentionMetadataError('sensitivity', `sensitivity must be one of ${SENSITIVITIES.join(', ')}`);
  }

  const memorySpaceRaw = input?.memorySpace ?? defaults.memorySpace ?? DEFAULT_MEMORY_SPACE;
  if (!isRetentionIdentifier(memorySpaceRaw)) {
    throw new RetentionMetadataError('memory_space', 'memory_space must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }

  const sourceSystemRaw = input?.sourceSystem ?? defaults.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
  if (!isRetentionIdentifier(sourceSystemRaw)) {
    throw new RetentionMetadataError('source_system', 'source_system must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }

  return {
    retentionClass: retentionClassRaw,
    memorySpace: memorySpaceRaw,
    sourceSystem: sourceSystemRaw,
    sensitivity: sensitivityRaw,
  };
}

// Default retention boundary for a freshly created Task: it is operational
// state, attributed to the agentlink control plane, internal by default.
export const TASK_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

// Default retention boundary for an agentlet progress event: short-term by
// default and attributed to the agentlet that emitted it.
export const EVENT_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'short_term',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: AGENTLET_SOURCE_SYSTEM,
};
// Default retention boundary for the singleton MainUser profile: operational
// state attributed to the agentlink control plane, internal by default.
export const MAIN_USER_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

// Default retention boundaries for AL-M1-004 channel users and platform
// identities: both are operational control-plane state owned by agentlink.
export const CHANNEL_USER_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

export const PLATFORM_IDENTITY_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

export const GROUP_PROFILE_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

export const SESSION_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'operational',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

// AL-M1-006 inbound source events and entries are short-term ingress records.
// The ingestion path overrides sourceSystem with the normalized inbound
// source_system so retention queries can attribute data to the real source.
export const MEMORY_CANDIDATE_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'memory_candidate',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

export const SOURCE_EVENT_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'short_term',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

export const ENTRY_RETENTION_DEFAULTS: RetentionDefaults = {
  retentionClass: 'short_term',
  sensitivity: 'internal',
  memorySpace: DEFAULT_MEMORY_SPACE,
  sourceSystem: DEFAULT_SOURCE_SYSTEM,
};

// Strip raw retention from an input object so idempotency signatures only
// depend on normalized retention metadata. This ensures that omitting
// retention (which falls back to defaults) produces the same signature as
// explicitly passing the default values.
export function withoutRawRetention<T>(input: T): Omit<T, 'retention'> {
  const { retention: _ignored, ...rest } = input as { retention?: RetentionMetadataInput };
  return rest as Omit<T, 'retention'>;
}
