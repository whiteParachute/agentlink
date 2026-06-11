import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = 'migrations/0001_initial.sql';

export function loadInitialMigration(): string {
  const candidates = [
    resolve(process.cwd(), MIGRATION_PATH),
    resolve(__dirname, '../../', MIGRATION_PATH),
  ];
  const migrationPath = candidates.find((candidate) => existsSync(candidate));
  if (!migrationPath) {
    throw new Error(`Cannot find ${MIGRATION_PATH} from ${candidates.join(', ')}`);
  }

  return readFileSync(migrationPath, 'utf8');
}
