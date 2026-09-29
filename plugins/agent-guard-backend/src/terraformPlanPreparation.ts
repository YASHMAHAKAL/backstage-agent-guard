import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import {
  assertTerraformPlanScope,
  TerraformPlanBinding,
} from './terraformPlan';
import { createTerraformPlanRegistration } from './terraformRunner';
import {
  readTerraformStateIdentity,
  verifyTerraformBackendTarget,
} from './terraformRemoteState';

const exec = promisify(execFile);
const digest = (value: Buffer | string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const accountId = z.string().regex(/^[0-9]{12}$/);
const profile = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

type Run = (binary: string, args: string[], cwd: string) => Promise<string>;

async function defaultRun(binary: string, args: string[], cwd: string) {
  try {
    const result = await exec(binary, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return result.stdout.trim();
  } catch {
    // Terraform and provider stderr may contain secrets. Never propagate it.
    throw new Error('Trusted Terraform plan command failed');
  }
}

async function checkedFile(path: string, maxSize = 1024 * 1024) {
  if ((await realpath(path)) !== path)
    throw new Error('Terraform input may not be a symlink');
  const info = await stat(path);
  if (!info.isFile() || info.size > maxSize)
    throw new Error('Invalid Terraform input file');
  return readFile(path);
}

async function hashFiles(directory: string, names: string[]) {
  const hash = createHash('sha256');
  for (const name of [...names].sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(await checkedFile(join(directory, name)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** This only creates a private saved plan. It never applies it, dispatches a
 * workflow, or treats a failed state read as an empty first state. The caller
 * must be a separately credentialed trusted runner, not a Backstage route. */
export async function prepareTerraformSavedPlan(options: {
  request: {
    id: string;
    requester: string;
    operation: 'foundation_setup' | 'capacity_change';
    root: 'registry' | 'staging';
    desiredWorkers?: number;
    previousWorkers?: number;
    configurationPrUrl?: string;
    configurationPrHeadCommit?: string;
  };
  configurationPr: { url: string; mergedCommit: string };
  checkoutDirectory: string;
  privateArtifactDirectory: string;
  backendConfigFile: string;
  awsProfile: string;
  expectedAccountId: string;
  runnerId: string;
  runnerKey: Buffer;
  verifyMergedReview: (input: {
    pullRequest: { url: string; mergedCommit: string };
    sourceCommit: string;
    root: 'registry' | 'staging';
    requesterRef: string;
    capacityDesiredWorkers?: number;
    capacityPrHeadCommit?: string;
  }) => Promise<boolean>;
  registerPlan: (
    message: ReturnType<typeof createTerraformPlanRegistration>,
  ) => Promise<void>;
  run?: Run;
  terraformBinary?: string;
  awsBinary?: string;
  now?: () => Date;
}) {
  const requestId = z.string().uuid().parse(options.request.id);
  const requester = z
    .string()
    .regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/)
    .parse(options.request.requester);
  const expectedAccountId = accountId.parse(options.expectedAccountId);
  const awsProfile = profile.parse(options.awsProfile);
  const runnerId = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,80}$/)
    .parse(options.runnerId);
  if (options.runnerKey.length < 32)
    throw new Error('Runner registration key is too short');
  if (
    options.request.operation === 'capacity_change' &&
    (options.request.root !== 'staging' ||
      options.request.configurationPrUrl !== options.configurationPr.url ||
      !gitSha.safeParse(options.request.configurationPrHeadCommit).success ||
      ![1, 2].includes(options.request.previousWorkers ?? 0) ||
      ![1, 2].includes(options.request.desiredWorkers ?? 0) ||
      options.request.previousWorkers === options.request.desiredWorkers)
  )
    throw new Error('Capacity request lacks its exact bounded PR and baseline');
  const reviewScope =
    options.request.operation === 'capacity_change'
      ? {
          capacityDesiredWorkers: options.request.desiredWorkers,
          capacityPrHeadCommit: options.request.configurationPrHeadCommit,
        }
      : {};
  const checkout = await realpath(options.checkoutDirectory);
  const root = join(
    checkout,
    options.request.root === 'registry'
      ? 'infra/aws/registry'
      : 'infra/aws/environments/staging',
  );
  if ((await realpath(root)) !== root)
    throw new Error('Terraform root must be a real checkout directory');
  const artifactDir = await realpath(options.privateArtifactDirectory);
  if (artifactDir === checkout || artifactDir.startsWith(`${checkout}${sep}`))
    throw new Error('Private plan artifacts must be outside the Git checkout');
  const artifactInfo = await stat(artifactDir);
  if (
    !artifactInfo.isDirectory() ||
    (artifactInfo.mode & 0o077) !== 0 ||
    artifactInfo.uid !== process.getuid?.()
  )
    throw new Error('Plan artifact directory must be owned and mode 0700');
  const run = options.run ?? defaultRun;
  const terraform = options.terraformBinary ?? 'terraform';
  const aws = options.awsBinary ?? 'aws';
  if (await run('git', ['status', '--porcelain'], root))
    throw new Error('Runner checkout is not clean');
  const sourceCommit = gitSha.parse(
    await run('git', ['rev-parse', 'HEAD'], root),
  );
  if (
    sourceCommit !== options.configurationPr.mergedCommit ||
    !(await options.verifyMergedReview({
      pullRequest: options.configurationPr,
      sourceCommit,
      root: options.request.root,
      requesterRef: requester,
      ...reviewScope,
    }))
  )
    throw new Error('Reviewed merged Terraform configuration is not current');
  const actualAccount = accountId.parse(
    await run(
      aws,
      [
        'sts',
        'get-caller-identity',
        '--profile',
        awsProfile,
        '--query',
        'Account',
        '--output',
        'text',
      ],
      root,
    ),
  );
  if (actualAccount !== expectedAccountId)
    throw new Error('Terraform runner is in the wrong AWS account');
  const names = await readdir(root);
  const configFiles = names.filter(name => /\.tf(?:\.json)?$/.test(name));
  const variableFiles = names.filter(name =>
    /(?:\.auto\.tfvars(?:\.json)?|^terraform\.tfvars(?:\.json)?)$/.test(name),
  );
  if (!configFiles.length || !variableFiles.length)
    throw new Error('Terraform configuration or variables are missing');
  const backendFile = resolve(root, options.backendConfigFile);
  if (!backendFile.startsWith(`${root}${sep}`))
    throw new Error('Backend configuration must be inside the reviewed root');
  const [configDigest, variablesDigest, backendBytes, lockBytes] =
    await Promise.all([
      hashFiles(root, configFiles),
      hashFiles(root, variableFiles),
      checkedFile(backendFile),
      checkedFile(join(root, '.terraform.lock.hcl')),
    ]);
  const backendText = backendBytes.toString('utf8');
  verifyTerraformBackendTarget({
    backendText,
    root: options.request.root,
    expectedProfile: awsProfile,
    expectedAccountId,
  });
  await run(
    terraform,
    [
      'init',
      '-input=false',
      '-lockfile=readonly',
      `-backend-config=${backendFile}`,
    ],
    root,
  );
  const state = await readTerraformStateIdentity({
    root: options.request.root,
    backendText,
    expectedProfile: awsProfile,
    expectedAccountId,
    run: (binary, args) => run(binary, args, root),
    terraformBinary: terraform,
    awsBinary: aws,
  });
  const planFileName = `${requestId}.tfplan`;
  const planPath = join(artifactDir, planFileName);
  const file = await open(
    planPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  await file.close();
  // From this point, an ambiguous registration retains the private artifact
  // for investigation. The caller must not blindly regenerate/retry a plan.
  await run(
    terraform,
    ['plan', '-input=false', '-lock=true', '-no-color', `-out=${planPath}`],
    root,
  );
  const planBytes = await checkedFile(planPath, 32 * 1024 * 1024);
  const planInfo = await stat(planPath);
  if ((planInfo.mode & 0o077) !== 0 || planInfo.uid !== process.getuid?.())
    throw new Error('Saved plan file is not private');
  const renderedPlanJson = JSON.parse(
    await run(terraform, ['show', '-json', planPath], root),
  ) as unknown;
  const plannedIdentity = z
    .object({
      variables: z.object({
        aws_profile: z.object({ value: profile }),
        expected_account_id: z.object({ value: accountId }),
      }),
    })
    .parse(renderedPlanJson).variables;
  if (
    plannedIdentity.aws_profile.value !== awsProfile ||
    plannedIdentity.expected_account_id.value !== actualAccount
  )
    throw new Error('Saved plan target differs from verified AWS identity');
  const terraformVersion = z
    .object({ terraform_version: z.string().regex(/^1\.15\.[0-9]+$/) })
    .parse(
      JSON.parse(await run(terraform, ['version', '-json'], root)),
    ).terraform_version;
  const now = (options.now ?? (() => new Date()))();
  const binding: TerraformPlanBinding = {
    schemaVersion: 1,
    policyVersion: 'rizz-terraform-v1',
    requestId,
    operation: options.request.operation,
    root: options.request.root,
    target: 'rizz-ai-eks-staging',
    accountId: actualAccount,
    region: 'us-east-1',
    requester,
    sourceCommit,
    providerLockDigest: digest(lockBytes),
    configDigest,
    variablesDigest,
    backendDigest: digest(backendBytes),
    planDigest: digest(planBytes),
    stateLineage: state.stateLineage,
    stateSerial: state.stateSerial,
    terraformVersion,
    runnerId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
  };
  const registration = createTerraformPlanRegistration({
    binding,
    renderedPlanJson,
    configurationPr: options.configurationPr,
    runnerKey: options.runnerKey,
  });
  assertTerraformPlanScope(binding, registration.summary);
  if (
    options.request.operation === 'capacity_change' &&
    (registration.summary.changes[0]?.workerDesiredSize?.before !==
      options.request.previousWorkers ||
      registration.summary.changes[0]?.workerDesiredSize?.after !==
        options.request.desiredWorkers)
  )
    throw new Error('Saved capacity plan differs from the bounded request');
  const [
    currentConfigDigest,
    currentVariablesDigest,
    currentBackend,
    currentLock,
  ] = await Promise.all([
    hashFiles(root, configFiles),
    hashFiles(root, variableFiles),
    checkedFile(backendFile),
    checkedFile(join(root, '.terraform.lock.hcl')),
  ]);
  if (
    currentConfigDigest !== configDigest ||
    currentVariablesDigest !== variablesDigest ||
    digest(currentBackend) !== binding.backendDigest ||
    digest(currentLock) !== binding.providerLockDigest ||
    (await run('git', ['status', '--porcelain'], root))
  )
    throw new Error('Terraform inputs changed while preparing the saved plan');
  if (
    !(await options.verifyMergedReview({
      pullRequest: options.configurationPr,
      sourceCommit,
      root: options.request.root,
      requesterRef: requester,
      ...reviewScope,
    }))
  )
    throw new Error('Configuration changed while preparing the saved plan');
  await options.registerPlan(registration);
  return { requestId, planFileName, planDigest: binding.planDigest };
}
