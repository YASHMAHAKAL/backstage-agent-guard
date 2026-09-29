import { validateCandidate } from './validate';

try {
  if (process.argv.length !== 6) throw new Error('Invalid arguments');
  const result = validateCandidate(
    ...(process.argv.slice(2) as [string, string, string, string]),
  );
  process.stdout.write(
    `Rizz manifest policy: ${result.state}. This is not approval or deployment proof.\n`,
  );
} catch {
  // Never dump manifests, operator metadata, subprocess stderr or credentials.
  process.stderr.write(
    'Rizz manifest policy failed. Review paths and the exact platform recipe.\n',
  );
  process.exitCode = 1;
}
