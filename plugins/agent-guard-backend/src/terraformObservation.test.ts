import { AwsCliTerraformObserver } from './terraformObservation';

const account = '123456789012';
const observer = (run: (args: string[]) => Promise<unknown>) =>
  new AwsCliTerraformObserver({
    profile: 'rizz-observer',
    expectedAccountId: account,
    run,
  });

describe('independent Terraform AWS inventory', () => {
  it('reads only fixed staging resources after verifying account', async () => {
    const calls: string[][] = [];
    const result = await observer(async args => {
      calls.push(args);
      if (args[0] === 'sts') return { Account: account };
      if (args[1] === 'describe-cluster')
        return { cluster: { name: 'rizz-eks-staging', status: 'ACTIVE' } };
      return {
        nodegroup: {
          nodegroupName: 'rizz-staging-worker',
          status: 'ACTIVE',
          scalingConfig: { desiredSize: 2 },
        },
      };
    }).observe('staging');
    expect(result.state).toBe('observed');
    expect(result.scope).toBe('partial_inventory');
    expect(result.checks[1].detail).toContain('desired workers 2');
    expect(calls).toEqual([
      ['sts', 'get-caller-identity'],
      ['eks', 'describe-cluster', '--name', 'rizz-eks-staging'],
      [
        'eks',
        'describe-nodegroup',
        '--cluster-name',
        'rizz-eks-staging',
        '--nodegroup-name',
        'rizz-staging-worker',
      ],
    ]);
  });

  it('fails closed before inventory when account differs', async () => {
    const run = jest.fn(async () => ({ Account: '999999999999' }));
    expect((await observer(run).observe('registry')).state).toBe('unavailable');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never exposes CLI errors or partial provider data', async () => {
    const result = await observer(async args => {
      if (args[0] === 'sts') return { Account: account };
      throw new Error('sensitive credential diagnostic');
    }).observe('staging');
    expect(result).toMatchObject({ state: 'unavailable', checks: [] });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('requires both repositories and the publisher role', async () => {
    const result = await observer(async args => {
      if (args[0] === 'sts') return { Account: account };
      if (args[0] === 'ecr')
        return { repositories: [{ repositoryName: 'rizz-staging-backend' }] };
      return { Role: { RoleName: 'rizz-staging-image-publisher' } };
    }).observe('registry');
    expect(result.state).toBe('incomplete');
    expect(result.checks.map(check => check.observed)).toEqual([
      true,
      false,
      true,
    ]);
  });
});
