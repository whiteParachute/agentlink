import { createHmac } from 'node:crypto';

export const SOURCE_HASH_PREFIX = 'hmac-sha256:v1:';
export const SOURCE_HASH_PATTERN = /^hmac-sha256:v1:[0-9a-f]{64}$/;
export const DEFAULT_SOURCE_HASH_SECRET = 'agentlink-dev-source-hash-secret';

export interface SourceHashSecretResolution {
  secret: string;
  configured: boolean;
}

export function resolveSourceHashSecret(env: NodeJS.ProcessEnv = process.env): SourceHashSecretResolution {
  const configured = env.AGENTLINK_SOURCE_HASH_SECRET?.trim();
  if (configured) return { secret: configured, configured: true };
  return { secret: DEFAULT_SOURCE_HASH_SECRET, configured: false };
}

export function createSourceHash(input: { sourceSystem: string; sourceRef: string; secret: string }): string {
  const digest = createHmac('sha256', input.secret)
    .update('agentlink-source-hash-v1')
    .update('\0')
    .update(input.sourceSystem)
    .update('\0')
    .update(input.sourceRef)
    .digest('hex');
  return `${SOURCE_HASH_PREFIX}${digest}`;
}

export function isSourceHash(value: string): boolean {
  return SOURCE_HASH_PATTERN.test(value);
}
