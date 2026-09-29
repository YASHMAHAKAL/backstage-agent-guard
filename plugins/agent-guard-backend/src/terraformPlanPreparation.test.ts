import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTerraformSavedPlan } from './terraformPlanPreparation';

const requestId = '8fdf4b5b-911d-4c2d-a2e7-92d164759f1c';
const sourceCommit = 'a'.repeat(40);
const configurationPr = {
  url: 'https://github.com/example/platform/pull/12',
  mergedCommit: sourceCommit,
};
const planJson = JSON.stringify({
  format_version: '1.2',
  terraform_version: '1.15.8',
  variables: {
    aws_profile: { value: 'platform-runner' },
    expected_account_id: { value: '000000000000' },
  },
  resource_changes: [
    {
      address: 'aws_ecr_repository.app["backend"]',
      type: 'aws_ecr_repository',
      change: { actions: ['create'], before: null, after: { id: 'private' } },
    },
  ],
});

let directory: string;
let root: string;
let artifactDir: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'terraform-plan-prep-'));
  root = join(directory, 'infra/aws/registry');
  artifactDir = await mkdtemp(join(tmpdir(), 'terraform-private-'));
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'main.tf'), 'resource "test" "one" {}\n'),
    writeFile(
      join(root, 'terraform.tfvars'),
      'aws_profile="platform-runner"\n',
    ),
    writeFile(
      join(root, 'state.backend.hcl'),
      'bucket="private"\nprofile="platform-runner"\nallowed_account_ids=["000000000000"]\n',
    ),
    writeFile(join(root, '.terraform.lock.hcl'), '# lock\n'),
  ]);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(artifactDir, { recursive: true, force: true });
});

function harness(overrides?: {
  stateUnavailable?: boolean;
  stateProvenAbsent?: boolean;
  wrongAccount?: boolean;
  planJson?: string;
}) {
  const calls: string[] = [];
  const run = jest.fn(async (binary: string, args: string[]) => {
    const command = `${binary} ${args[0]}`;
    calls.push(command);
    if (command === 'git status') return '';
    if (command === 'git rev-parse') return sourceCommit;
    if (command === 'aws sts')
      return overrides?.wrongAccount ? '999999999999' : '000000000000';
    if (command === 'aws s3api' && overrides?.stateProvenAbsent)
      return JSON.stringify({
        Name: 'private',
        Prefix: 'rizz-platform/registry/terraform.tfstate',
        IsTruncated: false,
        KeyCount: 0,
      });
    if (command === 'terraform init') return '';
    if (command === 'terraform state') {
      if (overrides?.stateUnavailable) throw new Error('backend inaccessible');
      return JSON.stringify({
        lineage: '38a13b16-df15-41bb-8db7-6174d5e2b77f',
        serial: 1,
      });
    }
    if (command === 'terraform plan') {
      const output = args.find(arg => arg.startsWith('-out='));
      if (!output) throw new Error('Missing private output');
      await writeFile(output.slice(5), 'private saved plan', { mode: 0o600 });
      return '';
    }
    if (command === 'terraform show') return overrides?.planJson ?? planJson;
    if (command === 'terraform version')
      return JSON.stringify({ terraform_version: '1.15.8' });
    throw new Error(`Unexpected command: ${command}`);
  });
  const verifyMergedReview = jest.fn().mockResolvedValue(true);
  const registerPlan = jest.fn().mockResolvedValue(undefined);
  return { calls, run, verifyMergedReview, registerPlan };
}

function options(testHarness: ReturnType<typeof harness>) {
  return {
    request: {
      id: requestId,
      requester: 'user:default/requester',
      operation: 'foundation_setup' as const,
      root: 'registry' as const,
    },
    configurationPr,
    checkoutDirectory: directory,
    privateArtifactDirectory: artifactDir,
    backendConfigFile: 'state.backend.hcl',
    awsProfile: 'platform-runner',
    expectedAccountId: '000000000000',
    runnerId: 'terraform-runner-staging',
    runnerKey: Buffer.alloc(32, 7),
    ...testHarness,
  };
}

describe('trusted Terraform saved-plan preparation', () => {
  it('registers only a sanitized plan bound to a reviewed merge and a private artifact', async () => {
    const h = harness();
    const result = await prepareTerraformSavedPlan(options(h));
    expect(result.planFileName).toBe(`${requestId}.tfplan`);
    expect(h.verifyMergedReview).toHaveBeenCalledTimes(2);
    expect(h.registerPlan).toHaveBeenCalledTimes(1);
    const message = h.registerPlan.mock.calls[0][0];
    expect(message.binding.sourceCommit).toBe(sourceCommit);
    expect(message.binding.stateSerial).toBe(1);
    expect(message.summary.changes).toEqual([
      {
        address: 'aws_ecr_repository.app["backend"]',
        type: 'aws_ecr_repository',
        action: 'create',
      },
    ]);
    expect(JSON.stringify(message)).not.toContain('private saved plan');
    expect(JSON.stringify(message)).not.toContain('after');
    expect(h.calls).not.toContain('terraform apply');
  });

  it('fails closed before planning if the target account differs', async () => {
    const h = harness({ wrongAccount: true });
    await expect(prepareTerraformSavedPlan(options(h))).rejects.toThrow(
      'wrong AWS account',
    );
    expect(h.calls).not.toContain('terraform plan');
    expect(h.registerPlan).not.toHaveBeenCalled();
  });

  it('fails closed when the first-state object cannot be verified', async () => {
    const h = harness({ stateUnavailable: true });
    await expect(prepareTerraformSavedPlan(options(h))).rejects.toThrow(
      'Unable to verify remote Terraform state object',
    );
    expect(h.calls).not.toContain('terraform plan');
    expect(h.registerPlan).not.toHaveBeenCalled();
  });

  it('permits an initial plan only after the exact state key is proven absent', async () => {
    const h = harness({ stateUnavailable: true, stateProvenAbsent: true });
    await prepareTerraformSavedPlan(options(h));
    expect(h.calls).toContain('aws s3api');
    expect(h.registerPlan.mock.calls[0][0].binding).toMatchObject({
      stateLineage: null,
      stateSerial: null,
    });
  });

  it('rejects a backend pointed at a different account before init or plan', async () => {
    await writeFile(
      join(root, 'state.backend.hcl'),
      'bucket="private"\nprofile="platform-runner"\nallowed_account_ids=["999999999999"]\n',
    );
    const h = harness();
    await expect(prepareTerraformSavedPlan(options(h))).rejects.toThrow(
      'Remote backend target differs',
    );
    expect(h.calls).not.toContain('terraform init');
    expect(h.registerPlan).not.toHaveBeenCalled();
  });

  it('rejects an unreviewed configuration before AWS or Terraform commands', async () => {
    const h = harness();
    h.verifyMergedReview.mockResolvedValue(false);
    await expect(prepareTerraformSavedPlan(options(h))).rejects.toThrow(
      'Reviewed merged Terraform configuration is not current',
    );
    expect(h.calls).not.toContain('aws sts');
    expect(h.registerPlan).not.toHaveBeenCalled();
  });

  it('requires a saved capacity plan to match the exact PR and requested worker delta', async () => {
    const h = harness();
    const incomplete = {
      ...options(h),
      request: {
        ...options(h).request,
        operation: 'capacity_change' as const,
        root: 'staging' as const,
        previousWorkers: 1,
        desiredWorkers: 2,
      },
    };
    await expect(prepareTerraformSavedPlan(incomplete)).rejects.toThrow(
      'exact bounded PR',
    );
    expect(h.calls).not.toContain('terraform plan');

    const stagingRoot = join(directory, 'infra/aws/environments/staging');
    await mkdir(stagingRoot, { recursive: true });
    await Promise.all([
      writeFile(join(stagingRoot, 'main.tf'), 'resource "test" "one" {}\n'),
      writeFile(
        join(stagingRoot, 'terraform.tfvars'),
        'aws_profile="platform-runner"\n',
      ),
      writeFile(
        join(stagingRoot, 'capacity.auto.tfvars.json'),
        '{"worker_desired_size":2}\n',
      ),
      writeFile(
        join(stagingRoot, 'state.backend.hcl'),
        'bucket="private"\nprofile="platform-runner"\nallowed_account_ids=["000000000000"]\n',
      ),
      writeFile(join(stagingRoot, '.terraform.lock.hcl'), '# lock\n'),
    ]);
    const capacityPlanJson = JSON.stringify({
      ...JSON.parse(planJson),
      resource_changes: [
        {
          address: 'aws_eks_node_group.staging',
          type: 'aws_eks_node_group',
          change: {
            actions: ['update'],
            before: { scaling_config: [{ desired_size: 1 }] },
            after: { scaling_config: [{ desired_size: 2 }] },
          },
        },
      ],
    });
    const validHarness = harness({ planJson: capacityPlanJson });
    const input = {
      ...options(validHarness),
      request: {
        ...incomplete.request,
        configurationPrUrl: configurationPr.url,
        configurationPrHeadCommit: 'b'.repeat(40),
      },
    };
    const result = await prepareTerraformSavedPlan(input);
    expect(result.requestId).toBe(requestId);
    expect(validHarness.verifyMergedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterRef: 'user:default/requester',
        capacityDesiredWorkers: 2,
        capacityPrHeadCommit: 'b'.repeat(40),
      }),
    );
    expect(
      validHarness.registerPlan.mock.calls[0][0].summary.changes[0]
        .workerDesiredSize,
    ).toEqual({ before: 1, after: 2 });
  });
});
