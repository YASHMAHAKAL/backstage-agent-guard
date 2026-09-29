const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, readFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const script = resolve(__dirname, 'terraform-ci-inputs.cjs');

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-guard-ci-test-'));
  const checkout = join(temporary, 'checkout');
  const runnerTemp = join(temporary, 'runner-temp');
  await mkdir(join(checkout, 'infra/aws/registry'), { recursive: true });
  await mkdir(join(checkout, 'infra/aws/environments/staging'), {
    recursive: true,
  });
  await mkdir(runnerTemp);
  const githubEnv = join(temporary, 'github-env');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'YASHMAHAKAL/backstage-agent-guard',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'YASHMAHAKAL',
    GITHUB_WORKSPACE: checkout,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: githubEnv,
    AGENT_GUARD_RUNNER_BACKSTAGE_URL: 'https://review.example.test/',
    AGENT_GUARD_RUNNER_SERVICE_TOKEN: 'test-service-token',
    AGENT_GUARD_TERRAFORM_RUNNER_KEY: 'test-runner-key',
    AGENT_GUARD_TERRAFORM_APPROVAL_KEY: 'test-approval-key',
    AGENT_GUARD_TERRAFORM_EXPECTED_ACCOUNT_ID: '123456789012',
    AGENT_GUARD_TERRAFORM_GITHUB_READ_TOKEN: 'test-github-token',
    AGENT_GUARD_TERRAFORM_BACKEND_CONFIG: 'private backend test value',
    AGENT_GUARD_TERRAFORM_TFVARS: 'private variables test value',
  };
  return { temporary, checkout, env, githubEnv };
}

test('prepares only ignored private files outside the plan store', async () => {
  const input = await fixture();
  try {
    const run = spawnSync(process.execPath, [script, 'registry'], {
      env: input.env,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /private backend|private variables/);
    const root = join(input.checkout, 'infra/aws/registry');
    const backend = join(root, 'state.backend.hcl');
    const variables = join(root, 'terraform.tfvars');
    assert.equal(await readFile(backend, 'utf8'), 'private backend test value');
    assert.equal(
      await readFile(variables, 'utf8'),
      'private variables test value',
    );
    assert.equal((await stat(backend)).mode & 0o077, 0);
    assert.equal((await stat(variables)).mode & 0o077, 0);
    const output = await readFile(input.githubEnv, 'utf8');
    const directory = output.match(
      /AGENT_GUARD_TERRAFORM_PRIVATE_ARTIFACT_DIR=(.+)\n/,
    )?.[1];
    assert.ok(directory?.startsWith(input.env.RUNNER_TEMP));
    assert.equal((await stat(directory)).mode & 0o077, 0);
    const replay = spawnSync(process.execPath, [script, 'registry'], {
      env: input.env,
      encoding: 'utf8',
    });
    assert.notEqual(
      replay.status,
      0,
      'existing private inputs must not be overwritten',
    );
  } finally {
    await rm(input.temporary, { recursive: true, force: true });
  }
});

test('refuses non-main, wrong actor, and non-HTTPS runner target', async () => {
  const input = await fixture();
  try {
    for (const override of [
      { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_ACTOR: 'mystic-koragg' },
      { AGENT_GUARD_RUNNER_BACKSTAGE_URL: 'http://public.example.test/' },
    ]) {
      const run = spawnSync(process.execPath, [script, 'staging'], {
        env: { ...input.env, ...override },
        encoding: 'utf8',
      });
      assert.notEqual(run.status, 0);
    }
  } finally {
    await rm(input.temporary, { recursive: true, force: true });
  }
});
