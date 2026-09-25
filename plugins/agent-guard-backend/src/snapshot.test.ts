import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalize,
  createFrozenSnapshot,
  snapshotHasIntegrity,
} from './snapshot';

const proposal = {
  declaredIntent: 'Create a staging Node.js payments API',
  templateId: 'nodejs-api' as const,
  inputs: {
    serviceName: 'payments-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging' as const,
    description: 'Internal payments API',
  },
};

describe('frozen approval snapshots', () => {
  it('canonicalizes object keys deterministically', () => {
    expect(canonicalize({ z: 1, a: { y: true, b: 'value' } })).toBe(
      '{"a":{"b":"value","y":true},"z":1}',
    );
  });

  it('renders stable files and binds execution fields to one digest', () => {
    const first = createFrozenSnapshot({
      proposalId: 'proposal-1',
      proposal,
      requester: 'user:default/guest',
    });
    const second = createFrozenSnapshot({
      proposalId: 'proposal-1',
      proposal,
      requester: 'user:default/guest',
    });
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.files.map(file => file.path)).toEqual([
      'apps/staging/payments-api/catalog-info.yaml',
      'apps/staging/payments-api/deployment.yaml',
      'apps/staging/payments-api/service.yaml',
    ]);
    expect(first.files[1].content).toContain('name: payments-api');
    expect(first.files[1].content).toContain('replicas: 1');
    expect(first.files[1].content).not.toContain('${{ values.serviceName }}');
    expect(snapshotHasIntegrity(first)).toBe(true);
  });

  it('changes the approval digest when intent or generated output changes', () => {
    const original = createFrozenSnapshot({
      proposalId: 'proposal-1',
      proposal,
      requester: 'user:default/guest',
    });
    const changedIntent = createFrozenSnapshot({
      proposalId: 'proposal-1',
      proposal: { ...proposal, declaredIntent: 'Create another staging API' },
      requester: 'user:default/guest',
    });
    expect(changedIntent.digest).not.toBe(original.digest);

    const changedReplicas = createFrozenSnapshot({
      proposalId: 'proposal-1',
      proposal: {
        ...proposal,
        inputs: { ...proposal.inputs, replicas: 2 },
      },
      requester: 'user:default/guest',
    });
    expect(changedReplicas.digest).not.toBe(original.digest);
    expect(changedReplicas.files[1].content).toContain('replicas: 2');

    const tampered = structuredClone(original);
    tampered.files[0].content += '\n# changed after review\n';
    expect(snapshotHasIntegrity(tampered)).toBe(false);
  });

  it('binds a backend-recorded channel while preserving legacy snapshot digests', () => {
    const options = {
      proposalId: 'proposal-1',
      proposal,
      requester: 'user:default/requester',
    };
    const historical = createFrozenSnapshot(options);
    const mcp = createFrozenSnapshot({
      ...options,
      submissionChannel: 'mcp_action',
    });
    const rest = createFrozenSnapshot({
      ...options,
      submissionChannel: 'backstage_rest',
      intentSource: 'authenticated_user_submitted',
    });
    const legacyRest = createFrozenSnapshot({
      ...options,
      submissionChannel: 'backstage_rest',
    });
    expect(historical.envelope).toMatchObject({ schemaVersion: 1 });
    expect(historical.envelope).not.toHaveProperty('submissionChannel');
    expect(mcp.envelope).toMatchObject({
      schemaVersion: 2,
      submissionChannel: 'mcp_action',
      intentSource: 'agent_supplied',
    });
    expect(rest.envelope).toMatchObject({
      schemaVersion: 2,
      submissionChannel: 'backstage_rest',
      intentSource: 'authenticated_user_submitted',
    });
    expect(mcp.digest).not.toBe(rest.digest);
    expect(rest.digest).not.toBe(legacyRest.digest);
    expect(mcp.digest).not.toBe(historical.digest);
    expect(snapshotHasIntegrity(historical)).toBe(true);
    expect(snapshotHasIntegrity(mcp)).toBe(true);
    expect(snapshotHasIntegrity(rest)).toBe(true);
    expect(snapshotHasIntegrity(legacyRest)).toBe(true);

    const invalidMcpSource = structuredClone(mcp);
    invalidMcpSource.envelope.intentSource = 'authenticated_user_submitted';
    expect(snapshotHasIntegrity(invalidMcpSource)).toBe(false);

    const tampered = structuredClone(mcp);
    tampered.envelope.submissionChannel = 'backstage_rest';
    expect(snapshotHasIntegrity(tampered)).toBe(false);
  });

  it('does not reuse the historical PR #1 digest after the shared-directory migration', () => {
    const historical = createFrozenSnapshot({
      proposalId: '453bbb61-302a-47bb-817d-2599ac1acfe1',
      proposal: {
        declaredIntent:
          'Submit a new Agent Guard proposal for an internal staging Node.js API named gitops-pr-demo-api, owned by group:default/payments-team. Use the nodejs-api template. No public ingress or database. Do not reuse proposal 2a1574b0-3dbb-4552-9106-68f8a986d14c, run Scaffolder directly, or approve anything.',
        templateId: 'nodejs-api',
        inputs: {
          serviceName: 'gitops-pr-demo-api',
          requestedOwner: 'group:default/payments-team',
          environment: 'staging',
          description:
            'Internal staging Node.js API with no public ingress or database.',
        },
      },
      requester: 'user:default/developer',
      gitopsRepoUrl:
        'github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops',
    });
    expect(historical.envelope.schemaVersion).toBe(1);
    expect(historical.digest).not.toBe(
      'sha256:52de500a37f9968d2183892025e0be2d59e5430b988f118ab28fada0372f1f92',
    );
  });

  it.each([
    ['nodejs-api', undefined],
    ['fastapi-api', undefined],
    ['scheduled-worker', '0 2 * * *'],
  ] as const)(
    'matches the platform-owned %s template content',
    (templateId, schedule) => {
      const templateProposal = {
        ...proposal,
        templateId,
        inputs: { ...proposal.inputs, ...(schedule ? { schedule } : {}) },
      };
      const snapshot = createFrozenSnapshot({
        proposalId: 'proposal-1',
        proposal: templateProposal,
        requester: 'user:default/guest',
      });
      const contentDirectory = resolve(
        __dirname,
        '../../../catalog/templates',
        templateId,
        'content',
      );
      const expected = readdirSync(contentDirectory)
        .sort()
        .map(name => ({
          path: `apps/staging/payments-api/${name}`,
          content: readFileSync(resolve(contentDirectory, name), 'utf8')
            .replaceAll('${{ values.serviceName }}', 'payments-api')
            .replaceAll(
              '${{ values.requestedOwner }}',
              'group:default/payments-team',
            )
            .replaceAll('${{ values.replicas }}', '1')
            .replaceAll('${{ values.schedule }}', schedule ?? ''),
        }));
      expect(
        snapshot.files.map(file => ({
          path: file.path,
          content: file.content,
        })),
      ).toEqual(expected);
    },
  );

  it.each(['nodejs-api', 'fastapi-api', 'scheduled-worker'])(
    'always reaches the guarded publisher for %s',
    templateId => {
      const definition = readFileSync(
        resolve(
          __dirname,
          '../../../catalog/templates',
          templateId,
          'template.yaml',
        ),
        'utf8',
      );
      expect(definition).toContain('action: agent-guard:publish-gitops-pr');
      // Scaffolder evaluates step.if before task secrets enter the context.
      expect(definition).not.toMatch(/if:\s*\$\{\{\s*secrets\./);
    },
  );
});
