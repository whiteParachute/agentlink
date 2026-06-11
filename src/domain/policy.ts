import { resolve, sep } from 'node:path';
import type { CapabilityGrantRecord, Domain, JsonRecord, WorkdirAccessMode, WorkdirGrantRecord } from './entities.js';

export interface DispatchPolicyInput {
  domain: Domain;
  deviceId: string;
  runnerId: string;
  deviceNetworkScope: string;
  requestedNetworkScope: string;
  requiredCapabilities: readonly string[];
  declaredCapabilities: readonly string[];
  supportedCapabilities: readonly string[];
  capabilityGrants: readonly CapabilityGrantRecord[];
  workspace?: string;
  requiredWorkdirAccess?: WorkdirAccessMode;
  workdirGrants: readonly WorkdirGrantRecord[];
}

export type PolicyDenyCode = 'AL_NETWORK_SCOPE_DENIED' | 'AL_CAPABILITY_UNDECLARED' | 'AL_CAPABILITY_UNSUPPORTED' | 'AL_CAPABILITY_DENIED' | 'AL_WORKDIR_DENIED';

export interface DispatchPolicyResult {
  decision: 'ALLOW' | 'DENY';
  code?: PolicyDenyCode;
  reason?: string;
  input: JsonRecord;
}

export function evaluateDispatchPolicy(input: DispatchPolicyInput): DispatchPolicyResult {
  const decisionInput = toDecisionInput(input);
  if (input.deviceNetworkScope !== input.requestedNetworkScope) {
    return deny('AL_NETWORK_SCOPE_DENIED', decisionInput);
  }

  const declared = new Set(input.declaredCapabilities);
  const supported = new Set(input.supportedCapabilities);
  const granted = new Set(
    input.capabilityGrants
      .filter((grant) => grant.domain === input.domain && grant.deviceId === input.deviceId && grant.runnerId === input.runnerId && grant.grantStatus === 'GRANTED' && !grant.revokedAt)
      .map((grant) => grant.capability),
  );

  for (const capability of input.requiredCapabilities) {
    if (!declared.has(capability)) return deny('AL_CAPABILITY_UNDECLARED', decisionInput);
    if (!supported.has(capability)) return deny('AL_CAPABILITY_UNSUPPORTED', decisionInput);
    if (!granted.has(capability)) return deny('AL_CAPABILITY_DENIED', decisionInput);
  }

  if (input.workspace) {
    const requiredAccess = input.requiredWorkdirAccess ?? 'read_write';
    const matchingGrant = input.workdirGrants.find(
      (grant) =>
        grant.domain === input.domain &&
        grant.deviceId === input.deviceId &&
        !grant.revokedAt &&
        accessModeAllows(grant.accessMode, requiredAccess) &&
        isWorkdirCovered(grant.pathPrefix, input.workspace as string),
    );
    if (!matchingGrant) return deny('AL_WORKDIR_DENIED', decisionInput);
  }

  return { decision: 'ALLOW', input: decisionInput };
}

function deny(code: PolicyDenyCode, input: JsonRecord): DispatchPolicyResult {
  return { decision: 'DENY', code, reason: DENY_REASONS[code], input };
}

const DENY_REASONS: Record<PolicyDenyCode, string> = {
  AL_NETWORK_SCOPE_DENIED: 'requested network_scope is outside the device network_scope',
  AL_CAPABILITY_UNDECLARED: 'requested capability is not declared by this runner',
  AL_CAPABILITY_UNSUPPORTED: 'requested capability is not supported by this pull request',
  AL_CAPABILITY_DENIED: 'requested capability has no active grant',
  AL_WORKDIR_DENIED: 'Workspace is outside active workdir grants',
};

function toDecisionInput(input: DispatchPolicyInput): JsonRecord {
  return {
    domain: input.domain,
    device_id: input.deviceId,
    runner_id: input.runnerId,
    device_network_scope: input.deviceNetworkScope,
    requested_network_scope: input.requestedNetworkScope,
    required_capabilities: [...input.requiredCapabilities],
    declared_capabilities: [...input.declaredCapabilities],
    supported_capabilities: [...input.supportedCapabilities],
    workspace: input.workspace,
    required_workdir_access: input.requiredWorkdirAccess ?? 'read_write',
  };
}

function accessModeAllows(grantMode: WorkdirAccessMode, requiredMode: WorkdirAccessMode): boolean {
  if (grantMode === 'read_write') return true;
  return grantMode === requiredMode;
}

export function isWorkdirCovered(prefix: string, path: string): boolean {
  if (!prefix.startsWith('/') || !path.startsWith('/')) return false;
  const resolvedPath = resolve(path);
  const resolvedPrefix = resolve(prefix);
  return resolvedPath === resolvedPrefix || resolvedPath.startsWith(`${resolvedPrefix}${sep}`);
}


export interface StaticPolicyInput {
  domain: Domain;
  device: { id: string; networkScope: string };
  runner: { id: string; capabilities: readonly string[] };
  requestedCapabilities: readonly string[];
  requestedNetworkScope: string;
  workspace: string;
  workdirAccess: WorkdirAccessMode;
  capabilityGrants: readonly CapabilityGrantRecord[];
  workdirGrants: readonly WorkdirGrantRecord[];
}

export function evaluateStaticPolicy(input: StaticPolicyInput): DispatchPolicyResult {
  return evaluateDispatchPolicy({
    domain: input.domain,
    deviceId: input.device.id,
    runnerId: input.runner.id,
    deviceNetworkScope: input.device.networkScope,
    requestedNetworkScope: input.requestedNetworkScope,
    requiredCapabilities: input.requestedCapabilities,
    declaredCapabilities: input.runner.capabilities,
    supportedCapabilities: input.runner.capabilities,
    capabilityGrants: input.capabilityGrants,
    workspace: input.workspace,
    requiredWorkdirAccess: input.workdirAccess,
    workdirGrants: input.workdirGrants,
  });
}
