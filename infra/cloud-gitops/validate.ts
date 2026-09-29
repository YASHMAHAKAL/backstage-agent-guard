import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloudTargetSchema } from '../../plugins/agent-guard-backend/src/cloudTarget';
import { inspectCloudGitopsFiles } from '../../plugins/agent-guard-backend/src/cloudSnapshot';
import { canonicalize } from '../../plugins/agent-guard-backend/src/snapshot';

// Bundled from the same renderer/schema as Backstage: no second, weaker recipe.
// CI executes this bundle and reads target configuration from the trusted base,
// never a script/config supplied by the candidate PR.
export function validateCandidate(
  root: string,
  targetFile: string,
  base: string,
  revision: string,
) {
  if (![base, revision].every(value => /^[a-f0-9]{40}$/.test(value)))
    throw new Error('Full immutable revisions required');
  if (statSync(targetFile).size > 32768) throw new Error('Target too large');
  const target = cloudTargetSchema.parse(
    JSON.parse(readFileSync(targetFile, 'utf8')),
  );
  const git = (args: string[], maxBuffer = 2 * 1024 * 1024) =>
    execFileSync('git', ['-C', resolve(root), ...args], {
      encoding: 'utf8',
      maxBuffer,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
  const paths = git([
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    base,
    revision,
    '--',
  ])
    .split('\0')
    .filter(Boolean);
  const inApp = (path: string) =>
    path === target.gitopsPath || path.startsWith(`${target.gitopsPath}/`);
  if (!paths.some(inApp)) return { state: 'not_applicable' as const };
  if (paths.some(path => !inApp(path)))
    throw new Error('Cloud release includes unrelated paths');
  const readAppTree = (rev: string) => {
    const entries = git(['ls-tree', '-r', '-z', rev, '--', target.gitopsPath])
      .split('\0')
      .filter(Boolean);
    if (entries.length > 9) throw new Error('Unsupported application tree');
    const contents: Record<string, string> = {};
    for (const entry of entries) {
      const parsed = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!parsed) throw new Error('Symlinks and non-file resources forbidden');
      const path = parsed[3];
      const name = path.slice(target.gitopsPath.length + 1);
      if (
        !path.startsWith(`${target.gitopsPath}/`) ||
        name.includes('/') ||
        name in contents
      )
        throw new Error('Unsafe cloud path');
      contents[name] = git(['cat-file', 'blob', parsed[2]], 65536);
      if (contents[name] !== `${canonicalize(JSON.parse(contents[name]))}\n`)
        throw new Error('Canonical JSON-as-YAML required');
    }
    return contents;
  };
  const before = readAppTree(base);
  const after = readAppTree(revision);
  const from = inspectCloudGitopsFiles(before, target).state;
  const to = inspectCloudGitopsFiles(after, target).state;
  if ((from === 'absent' || from === 'present') && to === 'present')
    return { state: 'valid' as const, transition: 'app_change' as const };
  if (from === 'present' && to === 'retiring') {
    if (
      Object.keys(after).some(
        name => name !== 'kustomization.yaml' && after[name] !== before[name],
      )
    )
      throw new Error('Ingress retirement changed other app files');
    return { state: 'valid' as const, transition: 'remove_ingress' as const };
  }
  if (from === 'retiring' && to === 'retired')
    return { state: 'valid' as const, transition: 'remove_app' as const };
  throw new Error('Unsupported cloud application transition');
}
