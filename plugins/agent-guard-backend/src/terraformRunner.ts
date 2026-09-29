import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import {
  assertTerraformExecutionAuthorized,
  assertTerraformPlanScope,
  sanitizeTerraformPlan,
  TerraformPlanBinding,
} from './terraformPlan';
import { canonicalize } from './snapshot';
import { readTerraformStateIdentity } from './terraformRemoteState';

const exec = promisify(execFile);
const digest = (bytes: Buffer | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const boundedJson = (raw: string) => {
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024)
    throw new Error('Terraform private output exceeded the runner limit');
  return JSON.parse(raw) as unknown;
};

/** Attest only a bounded, redacted summary. Never POST `terraform show -json`
 * or saved-plan bytes to Backstage. The receiving service also verifies a
 * merged reviewed configuration PR before it offers plan review. */
export function createTerraformPlanRegistration(input: {
  binding: TerraformPlanBinding;
  renderedPlanJson: unknown;
  configurationPr: { url: string; mergedCommit: string };
  runnerKey: Buffer;
}) {
  if (input.runnerKey.length < 32)
    throw new Error('Runner registration key is too short');
  const summary = sanitizeTerraformPlan(input.renderedPlanJson);
  assertTerraformPlanScope(input.binding, summary);
  const message = {
    requestId: input.binding.requestId,
    binding: input.binding,
    summary,
    configurationPr: input.configurationPr,
  };
  return {
    ...message,
    proof: createTerraformRunnerProof(message, input.runnerKey),
  };
}

export function createTerraformRunnerProof(
  message: unknown,
  runnerKey: Buffer,
) {
  if (runnerKey.length < 32) throw new Error('Runner proof key is too short');
  return `sha256:${createHmac('sha256', runnerKey)
    .update(canonicalize(message))
    .digest('hex')}`;
}

async function hashFiles(directory: string, names: string[]) {
  const hash = createHash('sha256');
  for (const name of names.sort()) {
    const file = join(directory, name);
    if ((await realpath(file)) !== file)
      throw new Error('Terraform configuration may not use symlinks');
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('Invalid Terraform configuration file');
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** A designated runner process, not the Backstage HTTP process, supplies its
 * own short-lived AWS credentials and a clean, reviewed source checkout.
 * This library never fetches a plan from a browser or accepts arbitrary CLI
 * arguments. Callers must persist the receipt and runner result separately. */
export async function executeApprovedTerraformPlan(options: {
  root: 'registry' | 'staging';
  checkoutDirectory: string;
  privateArtifactDirectory: string;
  planFileName: string;
  runId: string;
  receipt: unknown;
  signingKey: Buffer;
  runnerId: string;
  backendConfigFile: string;
  isCurrentPlatformReviewer: (reviewer: string) => Promise<boolean>;
  isCurrentSourceCommit: (commit: string) => Promise<boolean>;
  terraformBinary?: string;
  awsBinary?: string;
}) {
  const checkout = await realpath(options.checkoutDirectory);
  const runId = z.string().uuid().parse(options.runId);
  const root =
    options.root === 'registry'
      ? join(checkout, 'infra/aws/registry')
      : join(checkout, 'infra/aws/environments/staging');
  const rootReal = await realpath(root);
  if (rootReal !== root)
    throw new Error('Terraform root must be a real directory in the checkout');
  const artifactDir = await realpath(options.privateArtifactDirectory);
  if (artifactDir === checkout || artifactDir.startsWith(`${checkout}${sep}`))
    throw new Error('Private plan artifacts must be outside the Git checkout');
  const dirInfo = await stat(artifactDir);
  if (
    !dirInfo.isDirectory() ||
    (dirInfo.mode & 0o077) !== 0 ||
    dirInfo.uid !== process.getuid?.()
  )
    throw new Error('Plan artifact directory must be private (mode 0700)');
  if (!/^[a-f0-9-]{36}\.tfplan$/.test(options.planFileName))
    throw new Error('Invalid saved plan filename');
  const planPath = join(artifactDir, options.planFileName);
  const actualPlanPath = await realpath(planPath);
  if (
    !actualPlanPath.startsWith(`${artifactDir}${sep}`) ||
    actualPlanPath !== planPath
  )
    throw new Error(
      'Saved plan may not be a symlink or leave the private store',
    );
  const planInfo = await stat(planPath);
  if (
    !planInfo.isFile() ||
    planInfo.size > 32 * 1024 * 1024 ||
    (planInfo.mode & 0o077) !== 0 ||
    planInfo.uid !== process.getuid?.()
  )
    throw new Error('Saved plan must be a bounded private file');
  const planBytes = await readFile(planPath);
  const terraform = options.terraformBinary ?? 'terraform';
  const aws = options.awsBinary ?? 'aws';
  const run = async (binary: string, args: string[]) => {
    try {
      return (
        await exec(binary, args, {
          cwd: rootReal,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 120000,
        })
      ).stdout.trim();
    } catch {
      // CLI stderr may contain values from state or providers. Never return it.
      throw new Error('Runner precondition command failed');
    }
  };
  const checkoutStatus = await run('git', ['status', '--porcelain']);
  if (checkoutStatus) throw new Error('Runner checkout is not clean');
  const sourceCommit = await run('git', ['rev-parse', 'HEAD']);
  if (!(await options.isCurrentSourceCommit(sourceCommit)))
    throw new Error('Reviewed source commit is no longer current');
  const renderedPlanJson = boundedJson(
    await run(terraform, ['show', '-json', planPath]),
  );
  const plannedIdentity = z
    .object({
      variables: z.object({
        aws_profile: z.object({
          value: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        }),
        expected_account_id: z.object({
          value: z.string().regex(/^[0-9]{12}$/),
        }),
      }),
    })
    .parse(renderedPlanJson).variables;
  // These roots explicitly pass aws_profile to the provider. Query that same
  // named profile, not the runner's unrelated default credential chain.
  const accountId = await run(aws, [
    'sts',
    'get-caller-identity',
    '--profile',
    plannedIdentity.aws_profile.value,
    '--query',
    'Account',
    '--output',
    'text',
  ]);
  if (plannedIdentity.expected_account_id.value !== accountId)
    throw new Error('Terraform provider account differs from the runner');
  const version = z
    .object({ terraform_version: z.string() })
    .parse(boundedJson(await run(terraform, ['version', '-json'])));
  const names = await readdir(rootReal);
  const configFiles = names.filter(name => /\.tf(?:\.json)?$/.test(name));
  const variableFiles = names.filter(name =>
    /(?:\.auto\.tfvars(?:\.json)?|^terraform\.tfvars(?:\.json)?)$/.test(name),
  );
  if (configFiles.length === 0 || variableFiles.length === 0)
    throw new Error(
      'Reviewed Terraform configuration or variables are missing',
    );
  const backendFile = resolve(rootReal, options.backendConfigFile);
  if (!backendFile.startsWith(`${rootReal}${sep}`))
    throw new Error('Backend configuration must be inside the reviewed root');
  if ((await realpath(backendFile)) !== backendFile)
    throw new Error('Backend configuration may not use symlinks');
  const backendInfo = await stat(backendFile);
  if (!backendInfo.isFile() || backendInfo.size > 1024 * 1024)
    throw new Error('Invalid backend configuration');
  const lockFile = join(rootReal, '.terraform.lock.hcl');
  if ((await realpath(lockFile)) !== lockFile)
    throw new Error('Provider lock file may not be a symlink');
  const [configDigest, variablesDigest, backendBytes, lockBytes] =
    await Promise.all([
      hashFiles(rootReal, configFiles),
      hashFiles(rootReal, variableFiles),
      readFile(backendFile),
      readFile(lockFile),
    ]);
  await run(terraform, [
    'init',
    '-input=false',
    '-lockfile=readonly',
    `-backend-config=${backendFile}`,
  ]);
  const state = await readTerraformStateIdentity({
    root: options.root,
    backendText: backendBytes.toString('utf8'),
    expectedProfile: plannedIdentity.aws_profile.value,
    expectedAccountId: accountId,
    run,
    terraformBinary: terraform,
    awsBinary: aws,
  });
  const rawReceipt = z
    .object({
      approval: z.object({ binding: z.unknown(), reviewer: z.string() }),
    })
    .parse(options.receipt);
  const approvedBinding = rawReceipt.approval.binding as TerraformPlanBinding;
  const liveBinding = {
    ...approvedBinding,
    root: options.root,
    sourceCommit,
    accountId,
    providerLockDigest: digest(lockBytes),
    configDigest,
    variablesDigest,
    backendDigest: digest(backendBytes),
    planDigest: digest(planBytes),
    stateLineage: state.stateLineage,
    stateSerial: state.stateSerial,
    terraformVersion: version.terraform_version,
    runnerId: options.runnerId,
  };
  const approval = assertTerraformExecutionAuthorized({
    receipt: options.receipt,
    signingKey: options.signingKey,
    expectedBinding: liveBinding,
    planBytes,
    renderedPlanJson,
    now: new Date(),
    reviewerStillPlatformMember: await options.isCurrentPlatformReviewer(
      rawReceipt.approval.reviewer,
    ),
    runnerId: options.runnerId,
    actualAwsAccountId: accountId,
  });
  const claimPath = join(artifactDir, `${approval.binding.requestId}.consumed`);
  // O_EXCL is a durable one-time claim. A crash after this point is ambiguous:
  // never retry automatically or remove the claim; inspect state/run first.
  const claim = await open(
    claimPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  await claim.writeFile(
    JSON.stringify({
      bindingDigest: approval.bindingDigest,
      consumedAt: new Date().toISOString(),
      runnerId: options.runnerId,
      runId,
    }),
  );
  await claim.sync();
  await claim.close();
  try {
    const exitCode = await new Promise<number | null>((done, fail) => {
      const process = spawn(
        terraform,
        ['apply', '-input=false', '-no-color', planPath],
        { cwd: rootReal, stdio: 'ignore', timeout: 60 * 60 * 1000 },
      );
      process.once('error', fail);
      process.once('close', code => done(code));
    });
    if (exitCode !== 0) throw new Error('Saved plan apply did not complete');
    return {
      status: 'applied' as const,
      requestId: approval.binding.requestId,
    };
  } catch {
    // A partial apply is possible. Keep the claim consumed and require a new
    // plan after the operator reconciles actual state.
    return {
      status: 'unknown' as const,
      requestId: approval.binding.requestId,
    };
  }
}
