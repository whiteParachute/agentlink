import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config/index.js';
import { AgentlinkError, isAgentlinkError } from './control-plane/errors.js';
import { InMemoryControlPlane, type CreateTaskInput, type RegisterDeviceInput } from './control-plane/in-memory.js';
import type { DeviceRecord, JsonRecord, RunRecord, RunnerRecord, TaskRecord } from './domain/entities.js';
import type { RunStatus } from './domain/status.js';
import { sendJson } from './http/json.js';

export interface ServerInfo {
  name: string;
  version: string;
  environment: string;
}

export interface AgentlinkServerOptions {
  controlPlane?: InMemoryControlPlane;
}

export function createAgentlinkServer(info: ServerInfo, options: AgentlinkServerOptions = {}) {
  const controlPlane = options.controlPlane ?? new InMemoryControlPlane();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, info, controlPlane).catch((error: unknown) => {
      if (isAgentlinkError(error)) {
        sendJson(res, error.statusCode, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
        return;
      }
      sendJson(res, 500, { ok: false, error: { code: 'AL_INTERNAL', message: error instanceof Error ? error.message : 'internal error' } });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  info: ServerInfo,
  controlPlane: InMemoryControlPlane,
): Promise<void> {
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
      capabilities: ['task-api', 'device-register', 'agentlet-pull', 'agentlet-progress', 'agentlet-complete'],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/tasks') {
    const body = await readJsonRecord(req);
    const taskSpec = optionalRecord(body, 'task_spec');
    const maxRetries = optionalInteger(body, 'max_retries');
    const input: CreateTaskInput = {
      source: requireString(body, 'source'),
      sourceRef: requireString(body, 'source_ref'),
      payload: optionalRecord(body, 'payload') ?? {},
      ...(taskSpec ? { taskSpec } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    };
    const idempotencyKey = getIdempotencyKey(req, body);
    const result = controlPlane.createTask(input, idempotencyKey);
    sendJson(res, result.created ? 201 : 200, toTaskRunEnvelope(result.task, result.run));
    return;
  }

  const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && taskMatch) {
    const task = controlPlane.getTask(taskMatch[1] ?? '');
    if (!task) throw new AgentlinkError(404, 'AL_TASK_NOT_FOUND', 'Task not found');
    const run = controlPlane.getRun(task.currentRunId);
    sendJson(res, 200, { task: toTaskDto(task), current_run: run ? toRunDto(run) : null });
    return;
  }

  const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && runMatch) {
    const run = controlPlane.getRun(runMatch[1] ?? '');
    if (!run) throw new AgentlinkError(404, 'AL_RUN_NOT_FOUND', 'Run not found');
    sendJson(res, 200, { run: toRunDto(run) });
    return;
  }

  const runEventsMatch = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (req.method === 'GET' && runEventsMatch) {
    const runId = runEventsMatch[1] ?? '';
    if (!controlPlane.getRun(runId)) throw new AgentlinkError(404, 'AL_RUN_NOT_FOUND', 'Run not found');
    const afterSeq = Number.parseInt(url.searchParams.get('after_seq') ?? '0', 10);
    sendJson(res, 200, { events: controlPlane.getRunEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0).map(toRunEventDto) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/devices/register') {
    const body = await readJsonRecord(req);
    const networkScope = optionalString(body, 'network_scope');
    const agentletVersion = optionalString(body, 'agentlet_version');
    const metadata = optionalRecord(body, 'metadata');
    const input: RegisterDeviceInput = {
      displayName: requireString(body, 'display_name'),
      ownerUserId: requireString(body, 'owner_user_id'),
      ...(networkScope ? { networkScope } : {}),
      ...(agentletVersion ? { agentletVersion } : {}),
      ...(metadata ? { metadata } : {}),
    };
    const result = controlPlane.registerDevice(input);
    sendJson(res, 201, {
      device_id: result.device.id,
      runner_id: result.runner.id,
      device_secret: result.deviceSecret,
      device: toDeviceDto(result.device),
      runner: toRunnerDto(result.runner),
    });
    return;
  }

  const heartbeatMatch = /^\/api\/v1\/devices\/([^/]+)\/heartbeat$/.exec(url.pathname);
  if (req.method === 'POST' && heartbeatMatch) {
    const deviceId = heartbeatMatch[1] ?? '';
    const device = controlPlane.heartbeat(deviceId, requireBearer(req));
    sendJson(res, 200, { device: toDeviceDto(device) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/pull') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    controlPlane.authenticateDevice(deviceId, requireBearer(req));
    const supportedCapabilities = optionalStringArray(body, 'supported_capabilities');
    const instruction = controlPlane.pull({
      deviceId,
      runnerId: requireString(body, 'runner_id'),
      ...(supportedCapabilities ? { supportedCapabilities } : {}),
    });
    if (!instruction) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, {
      run_id: instruction.runId,
      task_id: instruction.taskId,
      lease_id: instruction.leaseId,
      expires_at: instruction.expiresAt,
      instruction: instruction.instruction,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/ack') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    controlPlane.authenticateDevice(deviceId, requireBearer(req));
    ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const result = controlPlane.ackLease(requireString(body, 'lease_id'), requireBoolean(body, 'accepted'), optionalString(body, 'reason'));
    sendJson(res, 200, { lease: toLeaseDto(result.lease), run: toRunDto(result.run), task: toTaskDto(result.task) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/progress') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    controlPlane.authenticateDevice(deviceId, requireBearer(req));
    ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const event = controlPlane.appendProgress({
      runId: requireString(body, 'run_id'),
      leaseId: requireString(body, 'lease_id'),
      seq: requireInteger(body, 'seq'),
      eventType: requireString(body, 'event_type'),
      payload: optionalRecord(body, 'payload') ?? {},
    });
    sendJson(res, 200, { event: toRunEventDto(event) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/complete') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    controlPlane.authenticateDevice(deviceId, requireBearer(req));
    ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const status = requireString(body, 'status') as RunStatus;
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
      throw new AgentlinkError(400, 'AL_STATUS_INVALID', 'Complete status must be SUCCEEDED, FAILED, or CANCELLED');
    }
    const terminalResult = optionalRecord(body, 'result');
    const terminalError = optionalRecord(body, 'error');
    const metrics = optionalRecord(body, 'metrics');
    const result = controlPlane.completeRun({
      runId: requireString(body, 'run_id'),
      leaseId: requireString(body, 'lease_id'),
      status: status as 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
      ...(terminalResult ? { result: terminalResult } : {}),
      ...(terminalError ? { error: terminalError } : {}),
      ...(metrics ? { metrics } : {}),
    });
    sendJson(res, 200, { run: toRunDto(result.run), task: toTaskDto(result.task), lease: toLeaseDto(result.lease) });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'AL_NOT_FOUND', message: 'not found' } });
}

function toTaskRunEnvelope(task: TaskRecord, run: RunRecord) {
  return {
    task_id: task.id,
    current_run_id: run.id,
    task_status: task.status,
    run_status: run.status,
    task: toTaskDto(task),
    run: toRunDto(run),
  };
}

function toTaskDto(task: TaskRecord) {
  return {
    id: task.id,
    domain: task.domain,
    source: task.source,
    source_ref: task.sourceRef,
    payload: task.payload,
    task_spec: task.taskSpec,
    status: task.status,
    current_run_id: task.currentRunId,
    retry_count: task.retryCount,
    max_retries: task.maxRetries,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function toRunDto(run: RunRecord) {
  return {
    id: run.id,
    task_id: run.taskId,
    domain: run.domain,
    status: run.status,
    attempt_no: run.attemptNo,
    instruction: run.instruction,
    current_lease_id: run.currentLeaseId,
    result: run.result,
    error: run.error,
    metrics: run.metrics,
    version: run.version,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

function toLeaseDto(lease: { id: string; runId: string; domain: string; deviceId: string; runnerId: string; status: string; issuedAt: string; expiresAt: string; ackedAt?: string; renewedAt?: string; completedAt?: string; cancelledAt?: string; expireReason?: string; terminalPayloadHash?: string; version: number; createdAt: string; updatedAt: string }) {
  return {
    id: lease.id,
    run_id: lease.runId,
    domain: lease.domain,
    device_id: lease.deviceId,
    runner_id: lease.runnerId,
    status: lease.status,
    issued_at: lease.issuedAt,
    expires_at: lease.expiresAt,
    acked_at: lease.ackedAt,
    renewed_at: lease.renewedAt,
    completed_at: lease.completedAt,
    cancelled_at: lease.cancelledAt,
    expire_reason: lease.expireReason,
    terminal_payload_hash: lease.terminalPayloadHash,
    version: lease.version,
    created_at: lease.createdAt,
    updated_at: lease.updatedAt,
  };
}

function toRunEventDto(event: { runId: string; seq: number; domain: string; eventType: string; payload: JsonRecord; emittedAt: string }) {
  return {
    run_id: event.runId,
    seq: event.seq,
    domain: event.domain,
    event_type: event.eventType,
    payload: event.payload,
    emitted_at: event.emittedAt,
  };
}

function toDeviceDto(device: DeviceRecord) {
  return {
    id: device.id,
    domain: device.domain,
    display_name: device.displayName,
    network_scope: device.networkScope,
    owner_user_id: device.ownerUserId,
    trust_level: device.trustLevel,
    status: device.status,
    agentlet_version: device.agentletVersion,
    last_heartbeat_at: device.lastHeartbeatAt,
    created_at: device.createdAt,
    updated_at: device.updatedAt,
  };
}

function toRunnerDto(runner: RunnerRecord) {
  return {
    id: runner.id,
    device_id: runner.deviceId,
    runner_type: runner.runnerType,
    runner_version: runner.runnerVersion,
    model: runner.model,
    status: runner.status,
    max_concurrency: runner.maxConcurrency,
    capabilities: runner.capabilities,
  };
}

function ensureLeaseBelongsToDevice(controlPlane: InMemoryControlPlane, leaseId: string, deviceId: string): void {
  const lease = controlPlane.getLease(leaseId);
  if (!lease) throw new AgentlinkError(404, 'AL_LEASE_NOT_FOUND', 'Lease not found');
  if (lease.deviceId !== deviceId) throw new AgentlinkError(403, 'AL_RUN_001', 'Lease does not belong to this device');
}

async function readJsonRecord(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AgentlinkError(400, 'AL_BAD_JSON', 'Malformed JSON body');
    throw error;
  }
  if (!isRecord(parsed)) throw new AgentlinkError(400, 'AL_BAD_JSON', 'JSON body must be an object');
  return parsed;
}

function getIdempotencyKey(req: IncomingMessage, body: JsonRecord): string {
  const header = req.headers['idempotency-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const bodyValue = body.idempotency_key;
  return typeof bodyValue === 'string' ? bodyValue : '';
}

function requireBearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AgentlinkError(401, 'AL_AUTH_REQUIRED', 'Bearer device token is required');
  return header.slice('Bearer '.length);
}

function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a non-empty string`);
  return value;
}

function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a string`);
  return value;
}


function requireBoolean(body: JsonRecord, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a boolean`);
  return value;
}

function requireInteger(body: JsonRecord, key: string): number {
  const value = body[key];
  if (!Number.isInteger(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an integer`);
  return value as number;
}

function optionalInteger(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an integer`);
  return value as number;
}

function optionalRecord(body: JsonRecord, key: string): JsonRecord | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an object`);
  return value;
}

function optionalStringArray(body: JsonRecord, key: string): readonly string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an array of strings`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createAgentlinkServer({ name: config.serviceName, version: '0.1.0', environment: config.environment });
  server.listen(config.port, config.host, () => {
    console.log(`${config.serviceName} listening on ${config.host}:${config.port}`);
  });
}
