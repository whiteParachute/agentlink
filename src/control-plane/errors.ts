export class AgentlinkError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentlinkError';
  }
}

export function isAgentlinkError(error: unknown): error is AgentlinkError {
  return error instanceof AgentlinkError;
}
