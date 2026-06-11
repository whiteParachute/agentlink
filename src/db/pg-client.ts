import pg from 'pg';
import type { PoolConfig, QueryResult } from 'pg';
import type { SqlClient, SqlQueryResult } from './transaction.js';

export interface PgRuntimeOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  onPoolError?: (error: Error) => void;
}

export interface PgQueryable {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
}

export interface PgPoolClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
}

export class PgSqlClient implements SqlClient {
  constructor(private readonly client: PgQueryable) {}

  async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query(sql, params);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? 0,
    };
  }
}

const { Pool } = pg;

export class PgRuntime {
  constructor(private readonly pool: PgPoolLike) {}

  static fromOptions(options: PgRuntimeOptions): PgRuntime {
    const pool = new Pool(toPoolConfig(options));
    pool.on('error', (error: Error) => {
      if (options.onPoolError) {
        options.onPoolError(error);
        return;
      }
      console.error('Agentlink PostgreSQL pool idle client error:', error.message);
    });
    return new PgRuntime(pool);
  }

  async withClient<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(new PgSqlClient(client));
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toPoolConfig(options: PgRuntimeOptions): PoolConfig {
  const config: PoolConfig = {
    connectionString: options.connectionString,
  };
  if (options.max !== undefined) config.max = options.max;
  if (options.idleTimeoutMillis !== undefined) config.idleTimeoutMillis = options.idleTimeoutMillis;
  if (options.connectionTimeoutMillis !== undefined) config.connectionTimeoutMillis = options.connectionTimeoutMillis;
  if (options.applicationName !== undefined) config.application_name = options.applicationName;
  return config;
}
