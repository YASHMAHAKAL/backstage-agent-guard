import { statSync } from 'node:fs';

const missing = process.argv.slice(2).filter(path => {
  try {
    return !statSync(path).isFile();
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  process.stderr.write(
    `Missing private Backstage config: ${missing.join(', ')}\n` +
      'Create the reviewed .local.yaml files before selecting this profile.\n',
  );
  process.exitCode = 1;
}
