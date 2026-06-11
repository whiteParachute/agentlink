import { PostgreSqlRepository, type PostgreSqlRepositoryOptions } from './postgres-repository.js';
import { PgRuntime } from './pg-client.js';

export async function withPostgreSqlRepository<T>(
  runtime: PgRuntime,
  work: (repository: PostgreSqlRepository) => Promise<T>,
  options: PostgreSqlRepositoryOptions = {},
): Promise<T> {
  return await runtime.withClient(async (client) => work(new PostgreSqlRepository(client, options)));
}
