import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, type AgentlinkConfig } from './config/index.js';
import { AgentlinkError, isAgentlinkError } from './control-plane/errors.js';
import { InMemoryControlPlane, type CreateTaskInput, type RegisterDeviceInput } from './control-plane/in-memory.js';
import { PostgresControlPlane } from './control-plane/postgres.js';
import type { AgentlinkControlPlanePort } from './control-plane/port.js';
import { PgRuntime } from './db/pg-client.js';
import type { CapabilityGrantRecord, ChannelUserRecord, DeviceRecord, EntryRecord, GroupProfileRecord, JsonRecord, MainUserRecord, MemoryCandidateRecord, PlatformIdentityRecord, RunRecord, RunnerRecord, SourceEventRecord, SessionRecord, TaskRecord, WorkdirAccessMode, WorkdirGrantRecord } from './domain/entities.js';
import { mapFakeImEventToIngest, normalizeFakeImEvent, toFakeImEventDto } from './domain/fake-im.js';
import { mapFeishuSampleEventToIngest, normalizeFeishuSampleEvent, toFeishuSampleEventDto } from './domain/feishu-sample.js';
import { resolveReplyMode, type ReplyModeResolution } from './domain/reply-mode.js';
import { RetentionMetadataError, type RetentionMetadataInput } from './domain/retention.js';
import type { RunStatus } from './domain/status.js';
import { sendJson } from './http/json.js';
import { renderM1ShellHtml } from './web/m1-shell.js';

export interface ServerInfo {
  name: string;
  version: string;
  environment: string;
}

export interface AgentlinkServerOptions {
  controlPlane?: AgentlinkControlPlanePort;
  ingressBearerToken?: string;
}

interface IngressSecurityOptions {
  ingressBearerToken?: string;
}

export function createAgentlinkServer(info: ServerInfo, options: AgentlinkServerOptions = {}) {
  const controlPlane = options.controlPlane ?? new InMemoryControlPlane();
  const security = ingressSecurityOptions(options);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, info, controlPlane, security).catch((error: unknown) => {
      if (isAgentlinkError(error)) {
        sendJson(res, error.statusCode, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
        return;
      }
      if (error instanceof RetentionMetadataError) {
        sendJson(res, 400, { ok: false, error: { code: 'AL_BAD_REQUEST', message: error.message, field: error.field } });
        return;
      }
      sendJson(res, 500, { ok: false, error: { code: 'AL_INTERNAL', message: error instanceof Error ? error.message : 'internal error' } });
    });
  });
}

export function createAgentlinkServerFromConfig(config: AgentlinkConfig) {
  const runtime =
    config.storage === 'postgres'
      ? PgRuntime.fromOptions({
          connectionString: requireDatabaseUrl(config),
          max: config.databasePoolMax,
          idleTimeoutMillis: config.databaseIdleTimeoutMs,
          connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
          applicationName: config.serviceName,
        })
      : undefined;
  const server = createAgentlinkServer(
    { name: config.serviceName, version: '0.1.0', environment: config.environment },
    {
      controlPlane: runtime
        ? new PostgresControlPlane(runtime, sourceHashOptions(config))
        : new InMemoryControlPlane(sourceHashOptions(config)),
      ...(config.ingressBearerToken ? { ingressBearerToken: config.ingressBearerToken } : {}),
    },
  );
  if (runtime) server.on('close', () => void runtime.close());
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  info: ServerInfo,
  controlPlane: AgentlinkControlPlanePort,
  security: IngressSecurityOptions,
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

  if (req.method === 'GET' && (url.pathname === '/m1' || url.pathname === '/m1/')) {
    sendHtml(res, 200, renderM1ShellHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/meta') {
    sendJson(res, 200, {
      service: info.name,
      version: info.version,
      m1Scope: 'personal:telegram-agentlink-claw-tenc-codex',
      capabilities: [
        'task-api',
        'device-register',
        'device-grant-management',
        'device-revoke',
        'agentlet-pull',
        'agentlet-lease-renew',
        'agentlet-control',
        'agentlet-control-ack',
        'agentlet-recover',
        'agentlet-recover-decision',
        'agentlet-progress',
        'agentlet-complete',
        'channel-user-api',
        'group-profile-api',
        'ingress-api',
        'fake-im-api',
        'feishu-sample-api',
        'reply-mode-api',
        'session-api',
        'memory-candidate-api',
      ],
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/main-user/profile') {
    const mainUser = await controlPlane.getMainUserProfile();
    if (!mainUser) throw new AgentlinkError(404, 'AL_MAIN_USER_NOT_FOUND', 'Main user profile not initialized');
    sendJson(res, 200, { main_user: toMainUserDto(mainUser) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/main-user/profile') {
    const body = await readJsonRecord(req);
    const displayName = optionalNonEmptyString(body, 'display_name');
    const locale = optionalNonEmptyString(body, 'locale');
    const timezone = optionalNonEmptyString(body, 'timezone');
    const metadata = optionalRecord(body, 'metadata');
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.upsertMainUserProfile({
      ...(displayName ? { displayName } : {}),
      ...(locale ? { locale } : {}),
      ...(timezone ? { timezone } : {}),
      ...(metadata ? { metadata } : {}),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, { main_user: toMainUserDto(result.mainUser), created: result.created });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/channel-users/upsert') {
    const body = await readJsonRecord(req);
    const displayName = optionalNonEmptyString(body, 'display_name');
    const channelUserMetadata = optionalRecord(body, 'channel_user_metadata');
    const platformIdentityMetadata = optionalRecord(body, 'platform_identity_metadata');
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.upsertChannelUser({
      platform: requireString(body, 'platform'),
      externalId: requireString(body, 'external_id'),
      ...(displayName ? { displayName } : {}),
      ...(channelUserMetadata ? { channelUserMetadata } : {}),
      ...(platformIdentityMetadata ? { platformIdentityMetadata } : {}),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, {
      channel_user: toChannelUserDto(result.channelUser),
      platform_identity: toPlatformIdentityDto(result.platformIdentity),
      created: result.created,
    });
    return;
  }

  const channelUserCategoryMatch = /^\/api\/v1\/channel-users\/([^/]+)\/category$/.exec(url.pathname);
  if (req.method === 'PATCH' && channelUserCategoryMatch) {
    const body = await readJsonRecord(req);
    const result = await controlPlane.setChannelUserCategory({
      channelUserId: channelUserCategoryMatch[1] ?? '',
      category: requireString(body, 'category'),
    });
    sendJson(res, 200, { channel_user: toChannelUserDto(result.channelUser) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/platform-identities/resolve') {
    const platform = requireQueryString(url, 'platform');
    const externalId = requireQueryString(url, 'external_id');
    const result = await controlPlane.resolvePlatformIdentity({ platform, externalId });
    if (!result) throw new AgentlinkError(404, 'AL_PLATFORM_IDENTITY_NOT_FOUND', 'Platform identity not found');
    sendJson(res, 200, {
      channel_user: toChannelUserDto(result.channelUser),
      platform_identity: toPlatformIdentityDto(result.platformIdentity),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/group-profiles') {
    const body = await readJsonRecord(req);
    const displayName = optionalNonEmptyString(body, 'display_name');
    const groupType = optionalString(body, 'group_type');
    const tone = optionalString(body, 'tone');
    const defaultReplyMode = optionalString(body, 'default_reply_mode');
    const contextScope = optionalString(body, 'context_scope');
    const memoryScope = optionalString(body, 'memory_scope');
    const metadata = optionalRecord(body, 'metadata');
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.upsertGroupProfile({
      platform: requireString(body, 'platform'),
      externalGroupId: requireString(body, 'external_group_id'),
      ...(displayName ? { displayName } : {}),
      ...(groupType !== undefined ? { groupType } : {}),
      ...(tone !== undefined ? { tone } : {}),
      ...(defaultReplyMode !== undefined ? { defaultReplyMode } : {}),
      ...(contextScope !== undefined ? { contextScope } : {}),
      ...(memoryScope !== undefined ? { memoryScope } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, { group_profile: toGroupProfileDto(result.groupProfile), created: result.created });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/group-profiles/resolve') {
    const platform = requireQueryString(url, 'platform');
    const externalGroupId = requireQueryString(url, 'external_group_id');
    const groupProfile = await controlPlane.resolveGroupProfile({ platform, externalGroupId });
    if (!groupProfile) throw new AgentlinkError(404, 'AL_GROUP_PROFILE_NOT_FOUND', 'Group profile not found');
    sendJson(res, 200, { group_profile: toGroupProfileDto(groupProfile) });
    return;
  }

  const groupProfileDefaultsMatch = /^\/api\/v1\/group-profiles\/([^/]+)\/defaults$/.exec(url.pathname);
  if (req.method === 'PATCH' && groupProfileDefaultsMatch) {
    const body = await readJsonRecord(req);
    const defaultReplyMode = optionalString(body, 'default_reply_mode');
    const contextScope = optionalString(body, 'context_scope');
    const memoryScope = optionalString(body, 'memory_scope');
    const tone = optionalString(body, 'tone');
    const result = await controlPlane.setGroupProfileDefaults({
      groupProfileId: groupProfileDefaultsMatch[1] ?? '',
      ...(defaultReplyMode !== undefined ? { defaultReplyMode } : {}),
      ...(contextScope !== undefined ? { contextScope } : {}),
      ...(memoryScope !== undefined ? { memoryScope } : {}),
      ...(tone !== undefined ? { tone } : {}),
    });
    sendJson(res, 200, { group_profile: toGroupProfileDto(result.groupProfile) });
    return;
  }

  const groupProfileGetMatch = /^\/api\/v1\/group-profiles\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && groupProfileGetMatch) {
    const groupProfile = await controlPlane.getGroupProfile(groupProfileGetMatch[1] ?? '');
    if (!groupProfile) throw new AgentlinkError(404, 'AL_GROUP_PROFILE_NOT_FOUND', 'Group profile not found');
    sendJson(res, 200, { group_profile: toGroupProfileDto(groupProfile) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/ingress/events') {
    requireIngressBearer(req, security);
    const body = await readJsonRecord(req);
    const platform = optionalString(body, 'platform');
    const occurredAt = optionalString(body, 'occurred_at');
    const payload = optionalRecord(body, 'payload');
    const metadata = optionalRecord(body, 'metadata');
    const entryType = optionalString(body, 'entry_type');
    const externalChatId = optionalString(body, 'external_chat_id');
    const externalThreadId = optionalString(body, 'external_thread_id');
    const externalMessageId = optionalString(body, 'external_message_id');
    const speakerChannelUserId = optionalString(body, 'speaker_channel_user_id');
    const groupProfileId = optionalString(body, 'group_profile_id');
    const agentMentioned = optionalBoolean(body, 'agent_mentioned');
    const bodyText = optionalString(body, 'body_text');
    const entryMetadata = optionalRecord(body, 'entry_metadata');
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.ingestSourceEvent({
      sourceSystem: requireString(body, 'source_system'),
      sourceRef: requireString(body, 'source_ref'),
      eventType: requireString(body, 'event_type'),
      ...(platform !== undefined ? { platform } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(entryType !== undefined ? { entryType } : {}),
      ...(externalChatId !== undefined ? { externalChatId } : {}),
      ...(externalThreadId !== undefined ? { externalThreadId } : {}),
      ...(externalMessageId !== undefined ? { externalMessageId } : {}),
      ...(speakerChannelUserId !== undefined ? { speakerChannelUserId } : {}),
      ...(groupProfileId !== undefined ? { groupProfileId } : {}),
      ...(agentMentioned !== undefined ? { agentMentioned } : {}),
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(entryMetadata !== undefined ? { entryMetadata } : {}),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, {
      source_event: toSourceEventDto(result.sourceEvent),
      entry: toEntryDto(result.entry),
      created: result.created,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/fake-im/events') {
    requireIngressBearer(req, security);
    const fakeImEvent = normalizeFakeImEvent(await readJsonRecord(req));
    const result = await controlPlane.ingestSourceEvent(mapFakeImEventToIngest(fakeImEvent));
    sendJson(res, result.created ? 201 : 200, {
      fake_im_event: toFakeImEventDto(fakeImEvent),
      source_event: toSourceEventDto(result.sourceEvent),
      entry: toEntryDto(result.entry),
      created: result.created,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/feishu-sample/events') {
    requireIngressBearer(req, security);
    const feishuEvent = normalizeFeishuSampleEvent(await readJsonRecord(req));
    const result = await controlPlane.ingestSourceEvent(mapFeishuSampleEventToIngest(feishuEvent));
    sendJson(res, result.created ? 201 : 200, {
      feishu_event: toFeishuSampleEventDto(feishuEvent),
      source_event: toSourceEventDto(result.sourceEvent),
      entry: toEntryDto(result.entry),
      created: result.created,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/source-events/resolve') {
    requireIngressBearer(req, security);
    const sourceEvent = await controlPlane.resolveSourceEvent({
      sourceSystem: requireQueryString(url, 'source_system'),
      sourceRef: requireQueryString(url, 'source_ref'),
    });
    if (!sourceEvent) throw new AgentlinkError(404, 'AL_SOURCE_EVENT_NOT_FOUND', 'Source event not found');
    sendJson(res, 200, { source_event: toSourceEventDto(sourceEvent) });
    return;
  }

  const sourceEventEntryMatch = /^\/api\/v1\/source-events\/([^/]+)\/entry$/.exec(url.pathname);
  if (req.method === 'GET' && sourceEventEntryMatch) {
    requireIngressBearer(req, security);
    const entry = await controlPlane.getEntryBySourceEvent(sourceEventEntryMatch[1] ?? '');
    if (!entry) throw new AgentlinkError(404, 'AL_ENTRY_NOT_FOUND', 'Entry not found');
    sendJson(res, 200, { entry: toEntryDto(entry) });
    return;
  }

  const sourceEventGetMatch = /^\/api\/v1\/source-events\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && sourceEventGetMatch) {
    requireIngressBearer(req, security);
    const sourceEvent = await controlPlane.getSourceEvent(sourceEventGetMatch[1] ?? '');
    if (!sourceEvent) throw new AgentlinkError(404, 'AL_SOURCE_EVENT_NOT_FOUND', 'Source event not found');
    sendJson(res, 200, { source_event: toSourceEventDto(sourceEvent) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/sessions/resolve') {
    requireIngressBearer(req, security);
    const body = await readJsonRecord(req);
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.resolveSession({
      entryId: requireString(body, 'entry_id'),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, {
      large_session: toSessionDto(result.largeSession),
      small_session: result.smallSession ? toSessionDto(result.smallSession) : null,
      session: toSessionDto(result.session),
      entry: toEntryDto(result.entry),
      created: result.created,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/memory-candidates') {
    requireIngressBearer(req, security);
    const body = await readJsonRecord(req);
    const entryId = optionalString(body, 'entry_id');
    const sourceEventId = optionalString(body, 'source_event_id');
    const reason = optionalString(body, 'reason');
    const confidence = optionalNumber(body, 'confidence');
    const metadata = optionalRecord(body, 'metadata');
    const retention = optionalRetention(body, 'retention');
    const result = await controlPlane.createMemoryCandidate({
      sessionId: requireString(body, 'session_id'),
      candidateText: requireString(body, 'candidate_text'),
      ...(entryId !== undefined ? { entryId } : {}),
      ...(sourceEventId !== undefined ? { sourceEventId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(retention ? { retention } : {}),
    });
    sendJson(res, result.created ? 201 : 200, { memory_candidate: toMemoryCandidateDto(result.memoryCandidate), created: result.created });
    return;
  }

  const sessionMemoryCandidatesMatch = /^\/api\/v1\/sessions\/([^/]+)\/memory-candidates$/.exec(url.pathname);
  if (req.method === 'GET' && sessionMemoryCandidatesMatch) {
    requireIngressBearer(req, security);
    const memoryCandidates = await controlPlane.listMemoryCandidates(sessionMemoryCandidatesMatch[1] ?? '');
    sendJson(res, 200, { memory_candidates: memoryCandidates.map(toMemoryCandidateDto) });
    return;
  }

  const sessionGetMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && sessionGetMatch) {
    requireIngressBearer(req, security);
    const session = await controlPlane.getSession(sessionGetMatch[1] ?? '');
    if (!session) throw new AgentlinkError(404, 'AL_SESSION_NOT_FOUND', 'Session not found');
    sendJson(res, 200, { session: toSessionDto(session) });
    return;
  }

  const memoryCandidateStatusMatch = /^\/api\/v1\/memory-candidates\/([^/]+)\/status$/.exec(url.pathname);
  if (req.method === 'PATCH' && memoryCandidateStatusMatch) {
    requireIngressBearer(req, security);
    const body = await readJsonRecord(req);
    const reason = optionalString(body, 'reason');
    const result = await controlPlane.setMemoryCandidateStatus({
      memoryCandidateId: memoryCandidateStatusMatch[1] ?? '',
      status: requireString(body, 'status'),
      ...(reason !== undefined ? { reason } : {}),
    });
    sendJson(res, 200, { memory_candidate: toMemoryCandidateDto(result.memoryCandidate) });
    return;
  }

  const memoryCandidateGetMatch = /^\/api\/v1\/memory-candidates\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && memoryCandidateGetMatch) {
    requireIngressBearer(req, security);
    const memoryCandidate = await controlPlane.getMemoryCandidate(memoryCandidateGetMatch[1] ?? '');
    if (!memoryCandidate) throw new AgentlinkError(404, 'AL_MEMORY_CANDIDATE_NOT_FOUND', 'Memory candidate not found');
    sendJson(res, 200, { memory_candidate: toMemoryCandidateDto(memoryCandidate) });
    return;
  }

  const entryReplyModeMatch = /^\/api\/v1\/entries\/([^/]+)\/reply-mode$/.exec(url.pathname);
  if (req.method === 'GET' && entryReplyModeMatch) {
    requireIngressBearer(req, security);
    const entry = await controlPlane.getEntry(entryReplyModeMatch[1] ?? '');
    if (!entry) throw new AgentlinkError(404, 'AL_ENTRY_NOT_FOUND', 'Entry not found');
    const groupProfile = entry.groupProfileId ? await controlPlane.getGroupProfile(entry.groupProfileId) : undefined;
    if (entry.groupProfileId && !groupProfile) throw new AgentlinkError(404, 'AL_GROUP_PROFILE_NOT_FOUND', 'Group profile not found');
    sendJson(res, 200, toReplyModeResolutionDto(entry.id, resolveReplyMode({ entry, ...(groupProfile ? { groupProfile } : {}) })));
    return;
  }

  const entrySessionMatch = /^\/api\/v1\/entries\/([^/]+)\/session$/.exec(url.pathname);
  if (req.method === 'GET' && entrySessionMatch) {
    requireIngressBearer(req, security);
    const entry = await controlPlane.getEntry(entrySessionMatch[1] ?? '');
    if (!entry) throw new AgentlinkError(404, 'AL_ENTRY_NOT_FOUND', 'Entry not found');
    const result = await controlPlane.getEntrySession(entry.id);
    if (!result) throw new AgentlinkError(404, 'AL_SESSION_NOT_FOUND', 'Session not found');
    sendJson(res, 200, { session: toSessionDto(result.session), entry: toEntryDto(result.entry) });
    return;
  }

  const entryGetMatch = /^\/api\/v1\/entries\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && entryGetMatch) {
    requireIngressBearer(req, security);
    const entry = await controlPlane.getEntry(entryGetMatch[1] ?? '');
    if (!entry) throw new AgentlinkError(404, 'AL_ENTRY_NOT_FOUND', 'Entry not found');
    sendJson(res, 200, { entry: toEntryDto(entry) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/tasks') {
    const body = await readJsonRecord(req);
    const taskSpec = optionalRecord(body, 'task_spec');
    const maxRetries = optionalInteger(body, 'max_retries');
    const retention = optionalRetention(body, 'retention');
    const input: CreateTaskInput = {
      source: requireString(body, 'source'),
      sourceRef: requireString(body, 'source_ref'),
      payload: optionalRecord(body, 'payload') ?? {},
      ...(taskSpec ? { taskSpec } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(retention ? { retention } : {}),
    };
    const idempotencyKey = getIdempotencyKey(req, body);
    const result = await controlPlane.createTask(input, idempotencyKey);
    sendJson(res, result.created ? 201 : 200, toTaskRunEnvelope(result.task, result.run));
    return;
  }

  const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && taskMatch) {
    const task = await controlPlane.getTask(taskMatch[1] ?? '');
    if (!task) throw new AgentlinkError(404, 'AL_TASK_NOT_FOUND', 'Task not found');
    const run = await controlPlane.getRun(task.currentRunId);
    sendJson(res, 200, { task: toTaskDto(task), current_run: run ? toRunDto(run) : null });
    return;
  }

  const taskCancelMatch = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === 'POST' && taskCancelMatch) {
    const body = await readJsonRecord(req);
    const result = await controlPlane.cancelTask(taskCancelMatch[1] ?? '', optionalString(body, 'reason'));
    sendJson(res, 200, {
      task: toTaskDto(result.task),
      run: result.run ? toRunDto(result.run) : null,
      lease: result.lease ? toLeaseDto(result.lease) : null,
      control_actions: result.controlActions.map(toControlActionDto),
    });
    return;
  }

  const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && runMatch) {
    const run = await controlPlane.getRun(runMatch[1] ?? '');
    if (!run) throw new AgentlinkError(404, 'AL_RUN_NOT_FOUND', 'Run not found');
    sendJson(res, 200, { run: toRunDto(run) });
    return;
  }

  const runEventsMatch = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (req.method === 'GET' && runEventsMatch) {
    const runId = runEventsMatch[1] ?? '';
    if (!(await controlPlane.getRun(runId))) throw new AgentlinkError(404, 'AL_RUN_NOT_FOUND', 'Run not found');
    const afterSeq = Number.parseInt(url.searchParams.get('after_seq') ?? '0', 10);
    sendJson(res, 200, { events: (await controlPlane.getRunEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0)).map(toRunEventDto) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/devices/register') {
    const body = await readJsonRecord(req);
    const networkScope = optionalString(body, 'network_scope');
    const agentletVersion = optionalString(body, 'agentlet_version');
    const metadata = optionalRecord(body, 'metadata');
    const capabilityGrants = optionalStringArray(body, 'capability_grants');
    const workdirGrants = optionalWorkdirGrants(body, 'workdir_grants');
    const input: RegisterDeviceInput = {
      displayName: requireString(body, 'display_name'),
      ownerUserId: requireString(body, 'owner_user_id'),
      ...(networkScope ? { networkScope } : {}),
      ...(agentletVersion ? { agentletVersion } : {}),
      ...(metadata ? { metadata } : {}),
      ...(capabilityGrants ? { capabilityGrants } : {}),
      ...(workdirGrants ? { workdirGrants } : {}),
    };
    const result = await controlPlane.registerDevice(input);
    sendJson(res, 201, {
      device_id: result.device.id,
      runner_id: result.runner.id,
      device_secret: result.deviceSecret,
      device: toDeviceDto(result.device),
      runner: toRunnerDto(result.runner),
    });
    return;
  }

  const capabilityGrantsMatch = /^\/api\/v1\/devices\/([^/]+)\/capability-grants$/.exec(url.pathname);
  if (capabilityGrantsMatch && req.method === 'GET') {
    const grants = await controlPlane.listCapabilityGrants(capabilityGrantsMatch[1] ?? '');
    sendJson(res, 200, { capability_grants: grants.map(toCapabilityGrantDto) });
    return;
  }
  if (capabilityGrantsMatch && req.method === 'POST') {
    const body = await readJsonRecord(req);
    const grant = await controlPlane.grantCapability({
      deviceId: capabilityGrantsMatch[1] ?? '',
      runnerId: requireString(body, 'runner_id'),
      capability: requireString(body, 'capability'),
      grantedBy: optionalString(body, 'granted_by') ?? 'api',
    });
    sendJson(res, 201, { capability_grant: toCapabilityGrantDto(grant) });
    return;
  }

  const capabilityGrantRevokeMatch = /^\/api\/v1\/capability-grants\/([^/]+)\/revoke$/.exec(url.pathname);
  if (capabilityGrantRevokeMatch && req.method === 'POST') {
    const grant = await controlPlane.revokeCapabilityGrant(capabilityGrantRevokeMatch[1] ?? '');
    sendJson(res, 200, { capability_grant: toCapabilityGrantDto(grant) });
    return;
  }

  const workdirGrantsMatch = /^\/api\/v1\/devices\/([^/]+)\/workdir-grants$/.exec(url.pathname);
  if (workdirGrantsMatch && req.method === 'GET') {
    const grants = await controlPlane.listWorkdirGrants(workdirGrantsMatch[1] ?? '');
    sendJson(res, 200, { workdir_grants: grants.map(toWorkdirGrantDto) });
    return;
  }
  if (workdirGrantsMatch && req.method === 'POST') {
    const body = await readJsonRecord(req);
    const grant = await controlPlane.grantWorkdir({
      deviceId: workdirGrantsMatch[1] ?? '',
      pathPrefix: requireString(body, 'path_prefix'),
      accessMode: optionalAccessMode(body, 'access_mode') ?? 'read_write',
    });
    sendJson(res, 201, { workdir_grant: toWorkdirGrantDto(grant) });
    return;
  }

  const workdirGrantRevokeMatch = /^\/api\/v1\/workdir-grants\/([^/]+)\/revoke$/.exec(url.pathname);
  if (workdirGrantRevokeMatch && req.method === 'POST') {
    const grant = await controlPlane.revokeWorkdirGrant(workdirGrantRevokeMatch[1] ?? '');
    sendJson(res, 200, { workdir_grant: toWorkdirGrantDto(grant) });
    return;
  }

  const deviceRevokeMatch = /^\/api\/v1\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
  if (deviceRevokeMatch && req.method === 'POST') {
    const body = await readJsonRecord(req);
    const result = await controlPlane.revokeDevice(deviceRevokeMatch[1] ?? '', optionalString(body, 'reason'));
    sendJson(res, 200, {
      device: toDeviceDto(result.device),
      tasks: result.tasks.map(toTaskDto),
      runs: result.runs.map(toRunDto),
      leases: result.leases.map(toLeaseDto),
    });
    return;
  }

  const heartbeatMatch = /^\/api\/v1\/devices\/([^/]+)\/heartbeat$/.exec(url.pathname);
  if (req.method === 'POST' && heartbeatMatch) {
    const deviceId = heartbeatMatch[1] ?? '';
    const device = await controlPlane.heartbeat(deviceId, requireBearer(req));
    sendJson(res, 200, { device: toDeviceDto(device) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/pull') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    const supportedCapabilities = optionalStringArray(body, 'supported_capabilities');
    const instruction = await controlPlane.pull({
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

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/control/poll') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    const result = await controlPlane.pollControl(deviceId);
    sendJson(res, 200, { control_actions: result.controlActions.map(toControlActionDto) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/control/ack') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    const result = await controlPlane.ackControlAction(deviceId, requireString(body, 'action_id'));
    sendJson(res, 200, { control_action: toControlActionDto(result.controlAction) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/recover') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    const result = await controlPlane.recoverDevice(deviceId);
    sendJson(res, 200, { recoverable_runs: result.recoverableRuns.map(toRecoverableRunDto) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/recover/decision') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    await ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const decision = requireString(body, 'decision');
    if (decision !== 'continue' && decision !== 'discard') throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'decision must be continue or discard');
    const reason = optionalString(body, 'reason');
    const result = await controlPlane.decideRecovery({
      deviceId,
      leaseId: requireString(body, 'lease_id'),
      decision,
      ...(reason ? { reason } : {}),
    });
    sendJson(res, 200, {
      decision: result.decision,
      lease: toLeaseDto(result.lease),
      run: toRunDto(result.run),
      task: toTaskDto(result.task),
      retry_run: result.retryRun ? toRunDto(result.retryRun) : null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/ack') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    await ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const result = await controlPlane.ackLease(requireString(body, 'lease_id'), requireBoolean(body, 'accepted'), optionalString(body, 'reason'));
    sendJson(res, 200, { lease: toLeaseDto(result.lease), run: toRunDto(result.run), task: toTaskDto(result.task) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/lease/renew') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    await ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const result = await controlPlane.renewLease(requireString(body, 'lease_id'));
    sendJson(res, 200, {
      lease: toLeaseDto(result.lease),
      run: toRunDto(result.run),
      task: toTaskDto(result.task),
      control_actions: result.controlActions.map(toControlActionDto),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/progress') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    await ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const retention = optionalRetention(body, 'retention');
    const event = await controlPlane.appendProgress({
      runId: requireString(body, 'run_id'),
      leaseId: requireString(body, 'lease_id'),
      seq: requireInteger(body, 'seq'),
      eventType: requireString(body, 'event_type'),
      payload: optionalRecord(body, 'payload') ?? {},
      ...(retention ? { retention } : {}),
    });
    sendJson(res, 200, { event: toRunEventDto(event) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/agentlet/complete') {
    const body = await readJsonRecord(req);
    const deviceId = requireString(body, 'device_id');
    await controlPlane.authenticateDevice(deviceId, requireBearer(req));
    await ensureLeaseBelongsToDevice(controlPlane, requireString(body, 'lease_id'), deviceId);
    const status = requireString(body, 'status') as RunStatus;
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
      throw new AgentlinkError(400, 'AL_STATUS_INVALID', 'Complete status must be SUCCEEDED, FAILED, or CANCELLED');
    }
    const terminalResult = optionalRecord(body, 'result');
    const terminalError = optionalRecord(body, 'error');
    const metrics = optionalRecord(body, 'metrics');
    const result = await controlPlane.completeRun({
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
    retention: {
      retention_class: task.retentionClass,
      memory_space: task.memorySpace,
      source_system: task.sourceSystem,
      sensitivity: task.sensitivity,
    },
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
    policy_decision_id: run.policyDecisionId,
    result: run.result,
    error: run.error,
    metrics: run.metrics,
    retention: {
      retention_class: run.retentionClass,
      memory_space: run.memorySpace,
      source_system: run.sourceSystem,
      sensitivity: run.sensitivity,
    },
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

function toRunEventDto(event: { runId: string; seq: number; domain: string; eventType: string; payload: JsonRecord; retentionClass: string; memorySpace: string; sourceSystem: string; sensitivity: string; emittedAt: string }) {
  return {
    run_id: event.runId,
    seq: event.seq,
    domain: event.domain,
    event_type: event.eventType,
    payload: event.payload,
    retention: {
      retention_class: event.retentionClass,
      memory_space: event.memorySpace,
      source_system: event.sourceSystem,
      sensitivity: event.sensitivity,
    },
    emitted_at: event.emittedAt,
  };
}

function toControlActionDto(action: { id: string; type: 'cancel_run'; deviceId: string; runId: string; leaseId: string; reason: string; status: string; createdAt: string; acknowledgedAt?: string; updatedAt: string }) {
  return {
    action_id: action.id,
    type: action.type,
    device_id: action.deviceId,
    run_id: action.runId,
    lease_id: action.leaseId,
    reason: action.reason,
    status: action.status,
    created_at: action.createdAt,
    acknowledged_at: action.acknowledgedAt,
    updated_at: action.updatedAt,
  };
}

function toRecoverableRunDto(recoverable: { runId: string; taskId: string; leaseId: string; runStatus: string; leaseStatus: string; instruction: JsonRecord; expiresAt: string }) {
  return {
    run_id: recoverable.runId,
    task_id: recoverable.taskId,
    lease_id: recoverable.leaseId,
    run_status: recoverable.runStatus,
    lease_status: recoverable.leaseStatus,
    instruction: recoverable.instruction,
    expires_at: recoverable.expiresAt,
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
    revoked_at: device.revokedAt,
    created_at: device.createdAt,
    updated_at: device.updatedAt,
  };
}

function toCapabilityGrantDto(grant: CapabilityGrantRecord) {
  return {
    id: grant.id,
    domain: grant.domain,
    device_id: grant.deviceId,
    runner_id: grant.runnerId,
    capability: grant.capability,
    grant_status: grant.grantStatus,
    granted_by: grant.grantedBy,
    granted_at: grant.grantedAt,
    revoked_at: grant.revokedAt,
  };
}

function toWorkdirGrantDto(grant: WorkdirGrantRecord) {
  return {
    id: grant.id,
    domain: grant.domain,
    device_id: grant.deviceId,
    path_prefix: grant.pathPrefix,
    access_mode: grant.accessMode,
    created_at: grant.createdAt,
    revoked_at: grant.revokedAt,
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

function toMainUserDto(mainUser: MainUserRecord) {
  const dto: Record<string, unknown> = {
    id: mainUser.id,
    display_name: mainUser.displayName,
    metadata: mainUser.metadata,
    retention: {
      retention_class: mainUser.retentionClass,
      memory_space: mainUser.memorySpace,
      source_system: mainUser.sourceSystem,
      sensitivity: mainUser.sensitivity,
    },
    created_at: mainUser.createdAt,
    updated_at: mainUser.updatedAt,
  };
  if (mainUser.locale) dto.locale = mainUser.locale;
  if (mainUser.timezone) dto.timezone = mainUser.timezone;
  return dto;
}

function toChannelUserDto(channelUser: ChannelUserRecord) {
  return {
    id: channelUser.id,
    display_name: channelUser.displayName,
    category: channelUser.category,
    metadata: channelUser.metadata,
    retention: {
      retention_class: channelUser.retentionClass,
      memory_space: channelUser.memorySpace,
      source_system: channelUser.sourceSystem,
      sensitivity: channelUser.sensitivity,
    },
    created_at: channelUser.createdAt,
    updated_at: channelUser.updatedAt,
  };
}

function toPlatformIdentityDto(platformIdentity: PlatformIdentityRecord) {
  return {
    id: platformIdentity.id,
    channel_user_id: platformIdentity.channelUserId,
    platform: platformIdentity.platform,
    external_id: platformIdentity.externalId,
    normalized_external_id: platformIdentity.normalizedExternalId,
    display_name: platformIdentity.displayName,
    metadata: platformIdentity.metadata,
    retention: {
      retention_class: platformIdentity.retentionClass,
      memory_space: platformIdentity.memorySpace,
      source_system: platformIdentity.sourceSystem,
      sensitivity: platformIdentity.sensitivity,
    },
    created_at: platformIdentity.createdAt,
    updated_at: platformIdentity.updatedAt,
  };
}

function toGroupProfileDto(groupProfile: GroupProfileRecord) {
  return {
    id: groupProfile.id,
    platform: groupProfile.platform,
    external_group_id: groupProfile.externalGroupId,
    normalized_external_group_id: groupProfile.normalizedExternalGroupId,
    display_name: groupProfile.displayName,
    group_type: groupProfile.groupType,
    tone: groupProfile.tone,
    default_reply_mode: groupProfile.defaultReplyMode,
    context_scope: groupProfile.contextScope,
    memory_scope: groupProfile.memoryScope,
    metadata: groupProfile.metadata,
    retention: {
      retention_class: groupProfile.retentionClass,
      memory_space: groupProfile.memorySpace,
      source_system: groupProfile.sourceSystem,
      sensitivity: groupProfile.sensitivity,
    },
    created_at: groupProfile.createdAt,
    updated_at: groupProfile.updatedAt,
  };
}

function toSourceEventDto(sourceEvent: SourceEventRecord) {
  return {
    id: sourceEvent.id,
    source_system: sourceEvent.sourceSystem,
    source_ref: sourceEvent.sourceRef,
    source_hash: sourceEvent.sourceHash,
    event_type: sourceEvent.eventType,
    platform: sourceEvent.platform,
    occurred_at: sourceEvent.occurredAt,
    received_at: sourceEvent.receivedAt,
    payload: sourceEvent.payload,
    metadata: sourceEvent.metadata,
    retention: {
      retention_class: sourceEvent.retentionClass,
      memory_space: sourceEvent.memorySpace,
      source_system: sourceEvent.sourceSystem,
      sensitivity: sourceEvent.sensitivity,
    },
    created_at: sourceEvent.createdAt,
    updated_at: sourceEvent.updatedAt,
  };
}

function toSessionDto(session: SessionRecord) {
  return {
    id: session.id,
    session_scope: session.sessionScope,
    platform: session.platform,
    external_chat_id: session.externalChatId,
    external_thread_id: session.externalThreadId,
    parent_session_id: session.parentSessionId,
    group_profile_id: session.groupProfileId,
    natural_key: session.naturalKey,
    display_name: session.displayName,
    metadata: session.metadata,
    retention: {
      retention_class: session.retentionClass,
      memory_space: session.memorySpace,
      source_system: session.sourceSystem,
      sensitivity: session.sensitivity,
    },
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

function toMemoryCandidateDto(memoryCandidate: MemoryCandidateRecord) {
  return {
    id: memoryCandidate.id,
    session_id: memoryCandidate.sessionId,
    entry_id: memoryCandidate.entryId,
    source_event_id: memoryCandidate.sourceEventId,
    candidate_text: memoryCandidate.candidateText,
    status: memoryCandidate.status,
    reason: memoryCandidate.reason,
    confidence: memoryCandidate.confidence,
    natural_key: memoryCandidate.naturalKey,
    metadata: memoryCandidate.metadata,
    retention: {
      retention_class: memoryCandidate.retentionClass,
      memory_space: memoryCandidate.memorySpace,
      source_system: memoryCandidate.sourceSystem,
      sensitivity: memoryCandidate.sensitivity,
    },
    created_at: memoryCandidate.createdAt,
    updated_at: memoryCandidate.updatedAt,
  };
}

function toReplyModeResolutionDto(entryId: string, resolution: ReplyModeResolution) {
  return {
    entry_id: entryId,
    reply_mode: resolution.replyMode,
    target: resolution.target,
    in_thread: resolution.inThread,
    ...(resolution.replyToMessageId !== undefined ? { reply_to_message_id: resolution.replyToMessageId } : {}),
    reason: resolution.reason,
  };
}

function toEntryDto(entry: EntryRecord) {
  return {
    id: entry.id,
    source_event_id: entry.sourceEventId,
    entry_type: entry.entryType,
    platform: entry.platform,
    external_chat_id: entry.externalChatId,
    external_thread_id: entry.externalThreadId,
    external_message_id: entry.externalMessageId,
    speaker_channel_user_id: entry.speakerChannelUserId,
    group_profile_id: entry.groupProfileId,
    session_id: entry.sessionId,
    agent_mentioned: entry.agentMentioned,
    body_text: entry.bodyText,
    metadata: entry.metadata,
    retention: {
      retention_class: entry.retentionClass,
      memory_space: entry.memorySpace,
      source_system: entry.sourceSystem,
      sensitivity: entry.sensitivity,
    },
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

async function ensureLeaseBelongsToDevice(controlPlane: AgentlinkControlPlanePort, leaseId: string, deviceId: string): Promise<void> {
  const lease = await controlPlane.getLease(leaseId);
  if (!lease) throw new AgentlinkError(404, 'AL_LEASE_NOT_FOUND', 'Lease not found');
  if (lease.deviceId !== deviceId) throw new AgentlinkError(403, 'AL_RUN_001', 'Lease does not belong to this device');
}

function sourceHashOptions(config: AgentlinkConfig): { sourceHashSecret?: string } {
  return config.sourceHashSecret ? { sourceHashSecret: config.sourceHashSecret } : {};
}

function ingressSecurityOptions(options: { ingressBearerToken?: string }): IngressSecurityOptions {
  return options.ingressBearerToken ? { ingressBearerToken: options.ingressBearerToken } : {};
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  });
  res.end(html);
}

function requireDatabaseUrl(config: AgentlinkConfig): string {
  if (!config.databaseUrl) {
    throw new Error('AGENTLINK_DATABASE_URL is required when AGENTLINK_STORAGE=postgres');
  }
  return config.databaseUrl;
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

function requireQueryString(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (typeof value !== 'string' || value.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a non-empty string`);
  return value;
}

function requireBearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AgentlinkError(401, 'AL_AUTH_REQUIRED', 'Bearer device token is required');
  return header.slice('Bearer '.length);
}

function requireIngressBearer(req: IncomingMessage, security: IngressSecurityOptions): void {
  if (!security.ingressBearerToken) return;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AgentlinkError(401, 'AL_AUTH_REQUIRED', 'Bearer ingress token is required');
  if (header.slice('Bearer '.length) !== security.ingressBearerToken) {
    throw new AgentlinkError(403, 'AL_FORBIDDEN', 'Invalid ingress bearer token');
  }
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

function optionalNonEmptyString(body: JsonRecord, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value === undefined) return undefined;
  if (value.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a non-empty string`);
  return value;
}


function requireBoolean(body: JsonRecord, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a boolean`);
  return value;
}

function optionalBoolean(body: JsonRecord, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
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

function optionalNumber(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a finite number`);
  return value;
}

function optionalAccessMode(body: JsonRecord, key: string): WorkdirAccessMode | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === 'read' || value === 'write' || value === 'read_write') return value;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be read, write, or read_write`);
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

function optionalWorkdirGrants(body: JsonRecord, key: string): RegisterDeviceInput['workdirGrants'] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key}[${index}] must be an object`);
    const pathPrefix = entry.path_prefix;
    if (typeof pathPrefix !== 'string' || pathPrefix.length === 0) {
      throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key}[${index}].path_prefix must be a non-empty string`);
    }
    const accessMode = entry.access_mode;
    if (accessMode === undefined) return { pathPrefix };
    if (accessMode !== 'read' && accessMode !== 'write' && accessMode !== 'read_write') {
      throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key}[${index}].access_mode must be read, write, or read_write`);
    }
    return { pathPrefix, accessMode };
  });
}

function optionalRetention(body: JsonRecord, key: string): RetentionMetadataInput | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an object`);
  const result: RetentionMetadataInput = {};
  if (value.retention_class !== undefined) result.retentionClass = String(value.retention_class);
  if (value.memory_space !== undefined) result.memorySpace = String(value.memory_space);
  if (value.source_system !== undefined) result.sourceSystem = String(value.source_system);
  if (value.sensitivity !== undefined) result.sensitivity = String(value.sensitivity);
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const server = createAgentlinkServerFromConfig(config);
  server.listen(config.port, config.host, () => {
    console.log(`${config.serviceName} listening on ${config.host}:${config.port} (storage=${config.storage})`);
  });
}
