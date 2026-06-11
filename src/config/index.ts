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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentlinkConfig {
  return {
    host: env.AGENTLINK_HOST ?? '0.0.0.0',
    port: parseInteger(env.AGENTLINK_PORT, 8080),
    serviceName: env.AGENTLINK_SERVICE_NAME ?? 'agentlink-control-plane',
    environment: env.NODE_ENV ?? 'development',
    storage: parseStorage(env.AGENTLINK_STORAGE),
    ...(env.AGENTLINK_DATABASE_URL && env.AGENTLINK_DATABASE_URL.trim() !== '' ? { databaseUrl: env.AGENTLINK_DATABASE_URL } : {}),
    databasePoolMax: parseInteger(env.AGENTLINK_DATABASE_POOL_MAX, 10),
    databaseIdleTimeoutMs: parseInteger(env.AGENTLINK_DATABASE_IDLE_TIMEOUT_MS, 30_000),
    databaseConnectionTimeoutMs: parseInteger(env.AGENTLINK_DATABASE_CONNECTION_TIMEOUT_MS, 5_000),
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
