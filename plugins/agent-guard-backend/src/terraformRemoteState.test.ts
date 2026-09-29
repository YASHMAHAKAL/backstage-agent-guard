import {
  readTerraformStateIdentity,
  verifyTerraformBackendTarget,
} from './terraformRemoteState';

const backendText = [
  'bucket = "rizz-platform-state-test"',
  'profile = "platform-runner"',
  'allowed_account_ids = ["000000000000"]',
].join('\n');
const base = {
  root: 'registry' as const,
  backendText,
  expectedProfile: 'platform-runner',
  expectedAccountId: '000000000000',
};

describe('exact Terraform S3 state identity', () => {
  it('requires one backend bucket/profile/account target', () => {
    expect(verifyTerraformBackendTarget(base)).toEqual({
      bucket: 'rizz-platform-state-test',
      key: 'rizz-platform/registry/terraform.tfstate',
    });
    expect(() =>
      verifyTerraformBackendTarget({
        ...base,
        backendText: backendText.replace('000000000000', '999999999999'),
      }),
    ).toThrow('Remote backend target differs');
    expect(() =>
      verifyTerraformBackendTarget({
        ...base,
        backendText: `${backendText}\nbucket = "second-bucket"`,
      }),
    ).toThrow('Invalid Terraform backend target');
  });

  it('reads an existing state without listing S3', async () => {
    const run = jest.fn().mockResolvedValue(
      JSON.stringify({
        lineage: '38a13b16-df15-41bb-8db7-6174d5e2b77f',
        serial: 4,
      }),
    );
    expect(await readTerraformStateIdentity({ ...base, run })).toEqual({
      stateLineage: '38a13b16-df15-41bb-8db7-6174d5e2b77f',
      stateSerial: 4,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('allows an initial state only after an exact-key empty S3 listing', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('state absent'))
      .mockResolvedValueOnce(
        JSON.stringify({
          Name: 'rizz-platform-state-test',
          Prefix: 'rizz-platform/registry/terraform.tfstate',
          IsTruncated: false,
          KeyCount: 0,
        }),
      );
    expect(await readTerraformStateIdentity({ ...base, run })).toEqual({
      stateLineage: null,
      stateSerial: null,
    });
    expect(run.mock.calls[1][1]).toContain('--expected-bucket-owner');
    expect(run.mock.calls[1][1]).toContain('000000000000');
  });

  it('rejects an unreadable or present state object', async () => {
    const unavailable = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    await expect(
      readTerraformStateIdentity({ ...base, run: unavailable }),
    ).rejects.toThrow('Unable to verify');
    const present = jest
      .fn()
      .mockRejectedValueOnce(new Error('state failed'))
      .mockResolvedValueOnce(
        JSON.stringify({
          Name: 'rizz-platform-state-test',
          Prefix: 'rizz-platform/registry/terraform.tfstate',
          IsTruncated: false,
          KeyCount: 1,
          Contents: [{ Key: 'rizz-platform/registry/terraform.tfstate' }],
        }),
      );
    await expect(
      readTerraformStateIdentity({ ...base, run: present }),
    ).rejects.toThrow('not proven absent');
  });
});
