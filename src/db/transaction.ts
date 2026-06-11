export interface SqlQueryResult<Row = unknown> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}

export class RollbackFailureError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;

  constructor(originalError: unknown, rollbackError: unknown) {
    super('Transaction failed and rollback also failed');
    this.name = 'RollbackFailureError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

export async function withTransaction<T>(client: SqlClient, work: (tx: SqlClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      throw new RollbackFailureError(error, rollbackError);
    }
    throw error;
  }
}
