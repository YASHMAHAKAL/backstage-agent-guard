import {
  checkRelease,
  ReleaseCatalog,
  ReleaseEvidence,
  ReleasePolicy,
  ReleaseRecord,
  releaseDigest,
} from './releases';

const commit = 'a'.repeat(40);
const now = Date.parse('2026-09-26T12:00:00Z');
const policy: ReleasePolicy = {
  repository: 'example/rizz',
  ref: 'refs/heads/master',
  workflowPath: '.github/workflows/publish.yml',
  frontendRepository:
    '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-frontend',
  backendRepository:
    '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-backend',
};
function fixture(): { record: ReleaseRecord; evidence: ReleaseEvidence } {
  const record: ReleaseRecord = {
    schemaVersion: 1,
    releaseId: `rizz-${commit}-100-1`,
    source: { repository: policy.repository, ref: policy.ref, commit },
    workflow: { path: policy.workflowPath, runId: 100, runAttempt: 1 },
    createdAt: '2026-09-26T10:00:00Z',
    expiresAt: '2026-10-03T10:00:00Z',
    checks: {
      tests: 'passed',
      scan: 'passed',
      policyVersion: 'rizz-build-v1-high-critical',
    },
    images: {
      frontend: {
        repository: policy.frontendRepository,
        digest: `sha256:${'b'.repeat(64)}`,
        sourceCommit: commit,
      },
      backend: {
        repository: policy.backendRepository,
        digest: `sha256:${'c'.repeat(64)}`,
        sourceCommit: commit,
      },
    },
  };
  return {
    record,
    evidence: {
      repository: policy.repository,
      ref: policy.ref,
      commit,
      workflowPath: policy.workflowPath,
      runId: 100,
      runAttempt: 1,
      conclusion: 'success',
      event: 'push',
      artifactExpired: false,
      artifactRecordDigest: releaseDigest(record),
      verifiedImages: Object.values(record.images).map(
        i => `${i.repository}@${i.digest}`,
      ),
    },
  };
}

describe('paired release verification (test fixtures, not real CI provenance)', () => {
  it('revalidates exact evidence and the selected digest; never uses list/cache as authority', async () => {
    const f = fixture();
    const resolve = jest.fn().mockResolvedValue([f]);
    const read = jest.fn();
    const catalog = new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode: 'authenticated_ci', read, resolve },
    });
    expect(
      await catalog.resolve(f.record.releaseId, releaseDigest(f.record)),
    ).toEqual({
      state: 'verified',
      record: f.record,
      recordDigest: releaseDigest(f.record),
    });
    expect(read).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(f.record.releaseId);
    expect(
      await catalog.resolve(f.record.releaseId, `sha256:${'d'.repeat(64)}`),
    ).toMatchObject({
      reason: 'release_selection_changed',
    });
    resolve.mockRejectedValueOnce(new Error('private-token-details'));
    expect(
      await catalog.resolve(f.record.releaseId, releaseDigest(f.record)),
    ).toEqual({
      state: 'unavailable',
      reason: 'release_source_unavailable',
    });
  });
  it('refuses fixtures, disconnected resolvers and malformed selections', async () => {
    const f = fixture();
    const resolve = jest.fn().mockResolvedValue([f]);
    const catalog = new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode: 'fixture', read: async () => [f], resolve },
    });
    expect(
      await catalog.resolve(f.record.releaseId, releaseDigest(f.record)),
    ).toMatchObject({
      reason: 'trusted_resolver_not_connected',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(await catalog.resolve('bad', 'bad')).toMatchObject({
      reason: 'invalid_release_selection',
    });
    expect(
      await new ReleaseCatalog().resolve(
        f.record.releaseId,
        releaseDigest(f.record),
      ),
    ).toMatchObject({
      reason: 'trusted_publisher_not_connected',
    });
  });
  it('rejects missing, ambiguous, expired or wrong-ID exact results', async () => {
    const f = fixture();
    const resolve = jest.fn();
    const catalog = new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode: 'authenticated_ci', read: async () => [], resolve },
    });
    for (const entries of [[], [f, f]]) {
      resolve.mockResolvedValueOnce(entries);
      expect(
        await catalog.resolve(f.record.releaseId, releaseDigest(f.record)),
      ).toMatchObject({
        reason: 'release_missing_or_ambiguous',
      });
    }
    resolve.mockResolvedValueOnce([
      { ...f, evidence: { ...f.evidence, artifactExpired: true } },
    ]);
    expect(
      await catalog.resolve(f.record.releaseId, releaseDigest(f.record)),
    ).toMatchObject({ reason: 'release_expired' });
    resolve.mockResolvedValueOnce([f]);
    expect(
      await catalog.resolve(`rizz-${commit}-101-1`, releaseDigest(f.record)),
    ).toMatchObject({ reason: 'release_selection_changed' });
  });
  it('requires matching independent workflow, artifact and registry evidence', () => {
    const { record, evidence } = fixture();
    expect(checkRelease(record, evidence, policy, now)).toMatchObject({
      eligible: true,
      recordDigest: releaseDigest(record),
    });
  });
  it.each([
    'conclusion',
    'repository',
    'ref',
    'workflowPath',
    'commit',
    'event',
  ] as const)('rejects altered evidence: %s', key => {
    const { record, evidence } = fixture();
    evidence[key] = 'untrusted';
    expect(checkRelease(record, evidence, policy, now)).toEqual({
      eligible: false,
      reason: 'untrusted_workflow',
    });
  });
  it('rejects unknown fields, failed checks, mutable/missing image digests', () => {
    const { record, evidence } = fixture();
    for (const bad of [
      { ...record, secret: 'never-accepted' },
      { ...record, checks: { ...record.checks, scan: 'failed' } },
      {
        ...record,
        images: {
          ...record.images,
          backend: { ...record.images.backend, digest: 'latest' },
        },
      },
    ]) {
      expect(checkRelease(bad, evidence, policy, now)).toEqual({
        eligible: false,
        reason: 'invalid_record',
      });
    }
  });
  it('rejects expired records/artifacts and future timestamps', () => {
    const { record, evidence } = fixture();
    expect(
      checkRelease(record, { ...evidence, artifactExpired: true }, policy, now),
    ).toMatchObject({ reason: 'release_expired' });
    expect(
      checkRelease(record, evidence, policy, Date.parse(record.expiresAt)),
    ).toMatchObject({ reason: 'release_expired' });
    expect(
      checkRelease(
        { ...record, createdAt: '2026-09-27T12:00:00Z' },
        evidence,
        policy,
        now,
      ),
    ).toMatchObject({ reason: 'invalid_lifetime' });
  });
  it('rejects tampering, mismatched image pairs, deleted images and arbitrary registries', () => {
    const { record, evidence } = fixture();
    expect(
      checkRelease(
        record,
        { ...evidence, artifactRecordDigest: `sha256:${'d'.repeat(64)}` },
        policy,
        now,
      ),
    ).toMatchObject({ reason: 'record_integrity_mismatch' });
    expect(
      checkRelease(record, { ...evidence, verifiedImages: [] }, policy, now),
    ).toMatchObject({ reason: 'image_unavailable' });
    record.images.backend.sourceCommit = 'd'.repeat(40);
    expect(
      checkRelease(
        record,
        { ...evidence, artifactRecordDigest: releaseDigest(record) },
        policy,
        now,
      ),
    ).toMatchObject({ reason: 'image_pair_mismatch' });
    record.images.backend.sourceCommit = commit;
    record.images.backend.repository = 'docker.io/untrusted/image';
    expect(
      checkRelease(
        record,
        { ...evidence, artifactRecordDigest: releaseDigest(record) },
        policy,
        now,
      ),
    ).toMatchObject({ reason: 'unapproved_registry' });
  });
  it('defaults to no releases; fixtures cannot become eligible for proposals', async () => {
    expect(await new ReleaseCatalog().list()).toMatchObject({
      state: 'not_configured',
      items: [],
    });
    const catalog = new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode: 'fixture', read: async () => [fixture()] },
    });
    expect(await catalog.list()).toMatchObject({
      state: 'fixture',
      items: [{ eligibleForProposal: false }],
    });
  });
  it('omits rejected records and fails closed on outage or ambiguous release IDs', async () => {
    const good = fixture();
    const bad = {
      ...good,
      evidence: { ...good.evidence, artifactExpired: true },
    };
    const read = jest.fn().mockResolvedValue([good, bad]);
    const catalog = new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode: 'authenticated_ci', read },
    });
    expect(await catalog.list()).toMatchObject({
      state: 'available',
      items: [{ eligibleForProposal: true }],
      rejectedCount: 1,
    });
    read.mockRejectedValueOnce(new Error('private-token-details'));
    expect(await catalog.list()).toEqual({
      state: 'unavailable',
      reason: 'release_source_unavailable',
      items: [],
    });
    read.mockResolvedValueOnce([good, good]);
    expect(await catalog.list()).toMatchObject({
      state: 'unavailable',
      items: [],
    });
  });
});
