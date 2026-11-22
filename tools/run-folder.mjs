// The folder a transcript tool run reads and writes: <repo>/.tmp/<name>/, under the git-ignored .tmp/, so the user's
// own commands never land in a tracked path, and one folder per run, so two runs never overwrite each other's files.
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class RunFolderError extends Error {}

// Returns the run folder for name, creating it when create is set. Refuses a name that is not one plain path segment,
// and a folder that resolves outside the real .tmp/, as an existing junction or symbolic link there would.
export function runFolder(name, { create = false } = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new RunFolderError(`run name must be one plain path segment (letters, digits, '.', '_', '-'), got ${JSON.stringify(name)}`);
  const scratch = join(REPO, '.tmp');
  const folder = join(scratch, name);
  if (create) mkdirSync(folder, { recursive: true });
  let real;
  try {
    real = realpathSync(folder);
  } catch {
    return folder; // not created yet: the reader that opens a file in it reports the missing corpus
  }
  if (!real.startsWith(realpathSync(scratch) + sep)) throw new RunFolderError(`run folder ${folder} resolves outside ${scratch}`);

  return real;
}
