export interface AgentlinkConfig {
  host: string;
  port: number;
  serviceName: string;
  environment: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentlinkConfig {
  return {
    host: env.AGENTLINK_HOST ?? '0.0.0.0',
    port: parseInteger(env.AGENTLINK_PORT, 8080),
    serviceName: env.AGENTLINK_SERVICE_NAME ?? 'agentlink-control-plane',
    environment: env.NODE_ENV ?? 'development',
  };
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}
