import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config/index.js';
import { sendJson } from './http/json.js';

export interface ServerInfo {
  name: string;
  version: string;
  environment: string;
}

export function createAgentlinkServer(info: ServerInfo) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, service: info.name, version: info.version });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/readyz') {
      sendJson(res, 200, { ok: true, service: info.name, environment: info.environment });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/meta') {
      sendJson(res, 200, {
        service: info.name,
        version: info.version,
        m1Scope: 'personal:telegram-agentlink-claw-tenc-codex',
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createAgentlinkServer({ name: config.serviceName, version: '0.1.0', environment: config.environment });
  server.listen(config.port, config.host, () => {
    console.log(`${config.serviceName} listening on ${config.host}:${config.port}`);
  });
}
