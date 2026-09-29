#!/usr/bin/env node
// Prepare ignored private inputs on an ephemeral GitHub-hosted runner. This
// script never contacts AWS or Backstage and never prints the input values.
const { constants } = require('node:fs');
const {
  appendFile,
  chmod,
  mkdtemp,
  open,
  realpath,
} = require('node:fs/promises');
const { join, resolve, sep } = require('node:path');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Terraform CI configuration missing: ${name}`);
  return value;
}

async function writeNewPrivate(path, contents) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function main() {
  const root = process.argv[2];
  if (!['registry', 'staging'].includes(root) || process.argv.length !== 3)
    throw new Error('Expected the fixed registry or staging Terraform root');
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'YASHMAHAKAL/backstage-agent-guard' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_ACTOR !== 'YASHMAHAKAL'
  )
    throw new Error('Terraform CI is restricted to the reviewed main run');
  const base = new URL(required('AGENT_GUARD_RUNNER_BACKSTAGE_URL'));
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error(
      'GitHub-hosted Terraform CI needs a bare HTTPS Backstage origin',
    );
  for (const name of [
    'AGENT_GUARD_RUNNER_SERVICE_TOKEN',
    'AGENT_GUARD_TERRAFORM_RUNNER_KEY',
    'AGENT_GUARD_TERRAFORM_APPROVAL_KEY',
    'AGENT_GUARD_TERRAFORM_EXPECTED_ACCOUNT_ID',
    'AGENT_GUARD_TERRAFORM_GITHUB_READ_TOKEN',
    'AGENT_GUARD_TERRAFORM_BACKEND_CONFIG',
    'AGENT_GUARD_TERRAFORM_TFVARS',
    'GITHUB_ENV',
  ])
    required(name);
  const checkout = await realpath(required('GITHUB_WORKSPACE'));
  const runnerTemp = await realpath(required('RUNNER_TEMP'));
  if (runnerTemp === checkout || runnerTemp.startsWith(`${checkout}${sep}`))
    throw new Error('Runner temp must be outside the Git checkout');
  const terraformRoot = resolve(
    checkout,
    root === 'registry'
      ? 'infra/aws/registry'
      : 'infra/aws/environments/staging',
  );
  if ((await realpath(terraformRoot)) !== terraformRoot)
    throw new Error('Terraform root must be a real checkout directory');
  const artifactDir = await mkdtemp(join(runnerTemp, 'agent-guard-plan-'));
  await chmod(artifactDir, 0o700);
  await writeNewPrivate(
    join(terraformRoot, 'state.backend.hcl'),
    required('AGENT_GUARD_TERRAFORM_BACKEND_CONFIG'),
  );
  await writeNewPrivate(
    join(terraformRoot, 'terraform.tfvars'),
    required('AGENT_GUARD_TERRAFORM_TFVARS'),
  );
  await appendFile(
    required('GITHUB_ENV'),
    `AGENT_GUARD_TERRAFORM_PRIVATE_ARTIFACT_DIR=${artifactDir}\n`,
    { mode: 0o600 },
  );
  process.stdout.write('Private Terraform runner inputs prepared.\n');
}

main().catch(error => {
  process.stderr.write(`Terraform CI preparation stopped: ${error.message}\n`);
  process.exitCode = 1;
});
