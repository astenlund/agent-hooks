// The folder a transcript tool run reads and writes: <repo>/.tmp/<name>/, under the git-ignored .tmp/, so the user's
// own commands never land in a tracked path by accident, and one folder per run, so two runs never overwrite each
// other's files. The name is the guard; links someone places inside .tmp/ are theirs to keep pointing where they like.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// One plain lowercase segment that cannot end in a dot: Windows ignores letter case and drops a trailing dot, so
// REPLAY-1 or replay-1. would name the same folder as replay-1.
const NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/;

export class RunFolderError extends Error {}

// Returns the run folder for name, creating it when create is set; refuses a name that is not one plain path segment.
export function runFolder(name, { create = false } = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new RunFolderError(`run name must be one plain path segment (lowercase letters, digits, '.', '_', '-', not ending in '.'), got ${JSON.stringify(name)}`);
  const folder = join(REPO, '.tmp', name);
  if (create) mkdirSync(folder, { recursive: true });

  return folder;
}
