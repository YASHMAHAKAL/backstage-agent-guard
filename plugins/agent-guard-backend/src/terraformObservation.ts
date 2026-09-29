import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod/v3';

const execFileAsync = promisify(execFile);
const identitySchema = z.object({ Account: z.string().regex(/^[0-9]{12}$/) });
const clusterSchema = z.object({
  cluster: z.object({ name: z.string(), status: z.string() }),
});
const nodegroupSchema = z.object({
  nodegroup: z.object({
    nodegroupName: z.string(),
    status: z.string(),
    scalingConfig: z.object({ desiredSize: z.number().int() }),
  }),
});
const repositorySchema = z.object({
  repositories: z.array(z.object({ repositoryName: z.string() })),
});
const roleSchema = z.object({ Role: z.object({ RoleName: z.string() }) });

type Root = 'registry' | 'staging';
type Check = { name: string; observed: boolean; detail?: string };
export type TerraformAwsObservation = {
  state: 'observed' | 'incomplete' | 'unavailable';
  root: Root;
  observedAt: string;
  checks: Check[];
  /** A bounded inventory, not Terraform drift or complete foundation proof. */
  scope: 'partial_inventory';
};

export interface TerraformAwsReader {
  observe(root: Root): Promise<TerraformAwsObservation>;
}

type RunAws = (args: string[]) => Promise<unknown>;

/** A deliberately fixed, read-only inventory. AWS errors fail closed and no
 * provider output, CLI stderr, credentials, or state content reaches the UI. */
export class AwsCliTerraformObserver implements TerraformAwsReader {
  private readonly run: RunAws;

  constructor(options: {
    profile: string;
    expectedAccountId: string;
    run?: RunAws;
  }) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.profile) ||
      !/^[0-9]{12}$/.test(options.expectedAccountId)
    )
      throw new Error('Invalid Terraform observation profile or account');
    this.run =
      options.run ??
      (async args => {
        const env = {
          ...process.env,
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
          AWS_PAGER: '',
        };
        for (const key of [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
          'AWS_PROFILE',
          'AWS_DEFAULT_PROFILE',
          'AWS_ROLE_ARN',
          'AWS_WEB_IDENTITY_TOKEN_FILE',
        ])
          delete env[key];
        const { stdout } = await execFileAsync(
          'aws',
          [
            ...args,
            '--profile',
            options.profile,
            '--region',
            'us-east-1',
            '--output',
            'json',
            '--no-cli-pager',
          ],
          { env, timeout: 15000, maxBuffer: 65536 },
        );
        return JSON.parse(stdout);
      });
    this.expectedAccountId = options.expectedAccountId;
  }

  private readonly expectedAccountId: string;

  async observe(root: Root): Promise<TerraformAwsObservation> {
    const observedAt = new Date().toISOString();
    const unavailable = (): TerraformAwsObservation => ({
      state: 'unavailable',
      root,
      observedAt,
      checks: [],
      scope: 'partial_inventory',
    });
    try {
      const identity = identitySchema.parse(
        await this.run(['sts', 'get-caller-identity']),
      );
      if (identity.Account !== this.expectedAccountId) return unavailable();
      const checks: Check[] = [];
      if (root === 'staging') {
        const cluster = clusterSchema.parse(
          await this.run([
            'eks',
            'describe-cluster',
            '--name',
            'rizz-eks-staging',
          ]),
        ).cluster;
        checks.push({
          name: 'EKS cluster',
          observed:
            cluster.name === 'rizz-eks-staging' && cluster.status === 'ACTIVE',
          detail: cluster.status,
        });
        const group = nodegroupSchema.parse(
          await this.run([
            'eks',
            'describe-nodegroup',
            '--cluster-name',
            'rizz-eks-staging',
            '--nodegroup-name',
            'rizz-staging-worker',
          ]),
        ).nodegroup;
        checks.push({
          name: 'EKS node group',
          observed:
            group.nodegroupName === 'rizz-staging-worker' &&
            group.status === 'ACTIVE',
          detail: `${group.status}; desired workers ${group.scalingConfig.desiredSize}`,
        });
      } else {
        const names = ['rizz-staging-backend', 'rizz-staging-frontend'];
        const repositories = repositorySchema.parse(
          await this.run([
            'ecr',
            'describe-repositories',
            '--repository-names',
            ...names,
          ]),
        ).repositories;
        for (const name of names)
          checks.push({
            name: `ECR ${name}`,
            observed: repositories.some(repo => repo.repositoryName === name),
          });
        const role = roleSchema.parse(
          await this.run([
            'iam',
            'get-role',
            '--role-name',
            'rizz-staging-image-publisher',
          ]),
        ).Role;
        checks.push({
          name: 'Image publisher role',
          observed: role.RoleName === 'rizz-staging-image-publisher',
        });
      }
      return {
        state: checks.every(check => check.observed)
          ? 'observed'
          : 'incomplete',
        root,
        observedAt,
        checks,
        scope: 'partial_inventory',
      };
    } catch {
      return unavailable();
    }
  }
}
