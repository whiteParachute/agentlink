import { resolveSourceHashSecret } from '../domain/source-hash.js';
export interface AgentlinkConfig {
  host: string;
  port: number;
  serviceName: string;
  environment: string;
  storage: 'memory' | 'postgres';
  databaseUrl?: string;
  databasePoolMax: number;
  databaseIdleTimeoutMs: number;
  databaseConnectionTimeoutMs: number;
  sourceHashSecret?: string;
  sourceHashSecretConfigured?: boolean;
  ingressBearerToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentlinkConfig {
  const environment = env.NODE_ENV ?? 'development';
  const sourceHash = resolveSourceHashSecret(env);
  const ingressBearerToken = parseOptionalSecret(env.AGENTLINK_INGRESS_BEARER_TOKEN);
  if (environment === 'production' && !sourceHash.configured) {
    throw new Error('AGENTLINK_SOURCE_HASH_SECRET is required when NODE_ENV=production');
  }
  if (environment === 'production' && !ingressBearerToken) {
    throw new Error('AGENTLINK_INGRESS_BEARER_TOKEN is required when NODE_ENV=production');
  }
  return {
    host: env.AGENTLINK_HOST ?? '0.0.0.0',
    port: parseInteger(env.AGENTLINK_PORT, 8080),
    serviceName: env.AGENTLINK_SERVICE_NAME ?? 'agentlink-control-plane',
    environment,
    storage: parseStorage(env.AGENTLINK_STORAGE),
    ...(env.AGENTLINK_DATABASE_URL && env.AGENTLINK_DATABASE_URL.trim() !== '' ? { databaseUrl: env.AGENTLINK_DATABASE_URL } : {}),
    databasePoolMax: parseInteger(env.AGENTLINK_DATABASE_POOL_MAX, 10),
    databaseIdleTimeoutMs: parseInteger(env.AGENTLINK_DATABASE_IDLE_TIMEOUT_MS, 30_000),
    databaseConnectionTimeoutMs: parseInteger(env.AGENTLINK_DATABASE_CONNECTION_TIMEOUT_MS, 5_000),
    sourceHashSecret: sourceHash.secret,
    sourceHashSecretConfigured: sourceHash.configured,
    ...(ingressBearerToken ? { ingressBearerToken } : {}),
  };
}

function parseStorage(value: string | undefined): AgentlinkConfig['storage'] {
  if (value === undefined || value.trim() === '') return 'memory';
  if (value === 'memory' || value === 'postgres') return value;
  throw new Error(`Invalid AGENTLINK_STORAGE value: ${value}`);
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseOptionalSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
