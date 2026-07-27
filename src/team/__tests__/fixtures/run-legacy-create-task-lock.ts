import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [teamRoot, acquiredPath, releasePath] = process.argv.slice(2);
if (!teamRoot || !acquiredPath || !releasePath) process.exit(2);

const lockDir = join(teamRoot, '.lock.create-task');
await mkdir(lockDir);
try {
  await writeFile(join(lockDir, 'owner'), 'legacy-installed');
  const configPath = join(teamRoot, 'config.json');
  const manifestPath = join(teamRoot, 'manifest.v2.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
  const id = String(config.next_task_id ?? 1);
  await writeFile(acquiredPath, id);
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(join(teamRoot, 'tasks', 'task-' + id + '.json'), JSON.stringify({
    id,
    subject: 'legacy-installed',
    description: 'legacy-installed',
    status: 'pending',
    depends_on: [],
    version: 1,
    created_at: new Date().toISOString(),
  }, null, 2));
  config.next_task_id = Number(id) + 1;
  manifest.next_task_id = Number(id) + 1;
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(id);
} finally {
  await rm(lockDir, { recursive: true, force: true });
}
