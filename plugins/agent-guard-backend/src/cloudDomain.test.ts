import { cloudProposalInputSchema } from './cloudDomain';
import { proposalInputSchema } from './domain';

const input = {
  declaredIntent:
    'Deploy the paired Rizz.AI release to EKS staging; keep backend private.',
  templateId: 'deploy-rizz-ai',
  inputs: {
    releaseId: `rizz-${'a'.repeat(40)}-100-1`,
    releaseRecordDigest: `sha256:${'b'.repeat(64)}`,
    targetId: 'eks-staging',
    frontendReplicas: 1,
    backendReplicas: 2,
  },
};

describe('inactive cloud request contract', () => {
  it('requires an explicit paired release, pinned record and cloud target', () => {
    expect(cloudProposalInputSchema.parse(input)).toEqual(input);
    // Existing local API cannot accidentally enable the unfinished cloud path.
    expect(proposalInputSchema.safeParse(input).success).toBe(false);
  });
  it.each([0, 3, 1.5, '2', null, undefined])(
    'rejects unsupported replica values without coercion/defaults: %p',
    value => {
      for (const field of ['frontendReplicas', 'backendReplicas']) {
        expect(
          cloudProposalInputSchema.safeParse({
            ...input,
            inputs: { ...input.inputs, [field]: value },
          }).success,
        ).toBe(false);
      }
    },
  );
  it.each([
    'image',
    'repoUrl',
    'namespace',
    'owner',
    'secret',
    'manifest',
    'publicIngress',
  ])('rejects agent-supplied execution details: %s', field => {
    expect(
      cloudProposalInputSchema.safeParse({
        ...input,
        inputs: { ...input.inputs, [field]: 'untrusted' },
      }).success,
    ).toBe(false);
  });
  it('rejects local/production targets, mutable releases, unsafe integers and identity spoofing', () => {
    for (const extra of [
      { targetId: 'staging' },
      { targetId: 'production' },
      { releaseId: 'latest' },
      { releaseRecordDigest: 'latest' },
      { releaseId: `rizz-${'a'.repeat(40)}-9007199254740992-1` },
    ]) {
      expect(
        cloudProposalInputSchema.safeParse({
          ...input,
          inputs: { ...input.inputs, ...extra },
        }).success,
      ).toBe(false);
    }
    expect(
      cloudProposalInputSchema.safeParse({
        ...input,
        requester: 'user:default/admin',
      }).success,
    ).toBe(false);
  });
});
