import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useEffect, useState } from 'react';
import { CloudDeliveryPanel } from './CloudDeliveryPanel';
import { CloudRetirementPanel } from './CloudRetirementPanel';
import './ProposalsPage/ProposalsPage.css';
import './RizzControlCenter.css';

type Capability = {
  state: 'disabled' | 'configured';
  canSubmit: boolean;
  canRetire?: boolean;
  target?: {
    id: string;
    clusterName: string;
    namespace: string;
    region: string;
  };
  reviewPolicy?: {
    reviewerGroups: string[];
    memberOfReviewerGroup: boolean;
    distinctReviewerRequired: boolean;
  };
};
type Release = {
  releaseId: string;
  sourceCommit: string;
  expiresAt: string;
  eligibleForProposal: boolean;
};
type ReleaseListing = {
  state: 'not_configured' | 'unavailable' | 'fixture' | 'available';
  items: Release[];
};
type Proposal = {
  id: string;
  status: string;
  requester: string;
  snapshot: {
    envelope: {
      kind:
        | 'rizz_cloud_release'
        | 'rizz_cloud_runtime_change'
        | 'rizz_cloud_rollback'
        | 'rizz_cloud_retire_ingress'
        | 'rizz_cloud_retire_app';
      inputs?: { releaseId: string };
      changedFields?: Array<'frontendReplicas' | 'backendReplicas'>;
      before?: { frontendReplicas: number; backendReplicas: number };
      after?: { frontendReplicas: number; backendReplicas: number };
    };
  };
  viewerPermissions?: { canReview: boolean };
  decision?: { decision: string };
  execution?: {
    state: string;
    taskId?: string;
    prUrl?: string;
    errorCode?: string;
  };
};
type VerifiedDeployment = {
  proposalId: string;
  operation:
    | 'rizz_cloud_release'
    | 'rizz_cloud_runtime_change'
    | 'rizz_cloud_rollback';
  verifiedAt: string;
  mergeRevision: string;
  argoRevision: string;
  prUrl: string;
  frontendImage: string;
  backendImage: string;
  frontendReplicas: number;
  backendReplicas: number;
  sourceRelease?: { releaseId: string };
};
type Readiness = {
  checkedAt: string;
  scope: string;
  checks: Array<{
    id: string;
    title: string;
    state: 'pass' | 'fail' | 'unknown';
    detail: string;
    evidenceUrl: string;
    checkedAt: string;
  }>;
};
type Metrics =
  | { state: 'unavailable'; checkedAt: string }
  | {
      state: 'observed';
      checkedAt: string;
      scope: 'one_backend_replica';
      apiRequests: number;
      apiErrors: number;
      meanApiLatencySeconds: number | null;
      providerOutcomes: Record<string, number>;
      providerCalls: number;
      providerCallLimit: number;
      providerInFlight: number;
    };
type InfrastructureCapability = {
  state: 'disabled' | 'request_and_review';
  executable: false;
};
type ReadResult<T> =
  | { state: 'loading' }
  | { state: 'available'; value: T }
  | { state: 'unavailable' };

const loading = <T,>(): ReadResult<T> => ({ state: 'loading' });
const unavailable = <T,>(): ReadResult<T> => ({ state: 'unavailable' });
function describeReleases(listing: ReleaseListing, count: number) {
  switch (listing.state) {
    case 'available':
      return `${count} verified, unexpired release${
        count === 1 ? '' : 's'
      } available.`;
    case 'fixture':
      return 'Fixture evidence only; no deployable release.';
    case 'not_configured':
      return 'Trusted publisher is not connected.';
    case 'unavailable':
      return 'Release source unavailable.';
    default:
      return 'Release state unavailable.';
  }
}
function describeProposal(proposal: Proposal) {
  const envelope = proposal.snapshot?.envelope;
  if (envelope?.kind === 'rizz_cloud_retire_ingress')
    return 'Retirement · remove ingress';
  if (envelope?.kind === 'rizz_cloud_retire_app')
    return 'Retirement · remove app resources';
  if (envelope?.kind === 'rizz_cloud_release')
    return envelope.inputs?.releaseId
      ? `Paired release · ${envelope.inputs.releaseId}`
      : 'Paired release · details unavailable';
  if (envelope?.kind === 'rizz_cloud_rollback')
    return envelope.inputs?.releaseId
      ? `Rollback · ${envelope.inputs.releaseId}`
      : 'Rollback · details unavailable';
  if (envelope?.kind === 'rizz_cloud_runtime_change') {
    const changes = (envelope.changedFields ?? []).map(field => {
      const workload = field === 'frontendReplicas' ? 'frontend' : 'backend';
      const before = envelope.before?.[field];
      const after = envelope.after?.[field];
      return `${workload} ${before ?? '?'} → ${after ?? '?'}`;
    });
    return `Runtime replicas · ${changes.join(', ') || 'details unavailable'}`;
  }
  return 'Cloud proposal · details unavailable';
}

export function RizzControlCenter() {
  const { entity } = useEntity();
  const { fetch } = useApi(fetchApiRef);
  const [capability, setCapability] = useState<ReadResult<Capability>>(loading);
  const [releases, setReleases] = useState<ReadResult<ReleaseListing>>(loading);
  const [proposals, setProposals] = useState<ReadResult<Proposal[]>>(loading);
  const [history, setHistory] =
    useState<ReadResult<VerifiedDeployment[]>>(loading);
  const [readiness, setReadiness] = useState<ReadResult<Readiness>>(loading);
  const [metrics, setMetrics] = useState<ReadResult<Metrics>>(loading);
  const [infrastructure, setInfrastructure] =
    useState<ReadResult<InfrastructureCapability>>(loading);
  const [selectedProposal, setSelectedProposal] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setCapability(loading());
    setReleases(loading());
    setProposals(loading());
    setHistory(loading());
    setReadiness(loading());
    setMetrics(loading());
    setInfrastructure(loading());
    setSelectedProposal('');

    async function read<T>(path: string): Promise<T> {
      const response = await fetch(`plugin://agent-guard/rizz/${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Read failed');
      return response.json();
    }
    async function refreshData() {
      const [caps, listing, queue, deployments, checks, measurements, infra] =
        await Promise.allSettled([
          read<Capability>('capabilities'),
          read<ReleaseListing>('releases'),
          read<{ items: Proposal[] }>('proposals'),
          read<{ items: VerifiedDeployment[] }>('verified-deployments'),
          read<Readiness>('readiness'),
          read<Metrics>('metrics'),
          read<InfrastructureCapability>('terraform/capabilities'),
        ]);
      if (controller.signal.aborted) return;
      setCapability(
        caps.status === 'fulfilled' &&
          ['disabled', 'configured'].includes(caps.value?.state)
          ? { state: 'available', value: caps.value }
          : unavailable(),
      );
      setReleases(
        listing.status === 'fulfilled' &&
          ['not_configured', 'unavailable', 'fixture', 'available'].includes(
            listing.value?.state,
          ) &&
          Array.isArray(listing.value.items)
          ? { state: 'available', value: listing.value }
          : unavailable(),
      );
      setProposals(
        queue.status === 'fulfilled' && Array.isArray(queue.value?.items)
          ? { state: 'available', value: queue.value.items }
          : unavailable(),
      );
      setHistory(
        deployments.status === 'fulfilled' &&
          Array.isArray(deployments.value?.items)
          ? { state: 'available', value: deployments.value.items }
          : unavailable(),
      );
      setReadiness(
        checks.status === 'fulfilled' && Array.isArray(checks.value?.checks)
          ? { state: 'available', value: checks.value }
          : unavailable(),
      );
      setMetrics(
        measurements.status === 'fulfilled' &&
          ['observed', 'unavailable'].includes(measurements.value?.state)
          ? { state: 'available', value: measurements.value }
          : unavailable(),
      );
      setInfrastructure(
        infra.status === 'fulfilled' &&
          ['disabled', 'request_and_review'].includes(infra.value?.state)
          ? { state: 'available', value: infra.value }
          : unavailable(),
      );
    }
    void refreshData();
    return () => controller.abort();
  }, [fetch, refresh]);

  const visibleProposals =
    proposals.state === 'available' ? proposals.value : [];
  const selectedRecord = visibleProposals.find(
    proposal => proposal.id === selectedProposal,
  );
  const releaseCount =
    releases.state === 'available' && releases.value.state === 'available'
      ? releases.value.items.filter(
          release =>
            release.eligibleForProposal &&
            Date.parse(release.expiresAt) > Date.now(),
        ).length
      : 0;
  const owner = typeof entity.spec?.owner === 'string' ? entity.spec.owner : '';
  const isComponent = entity.kind.toLowerCase() === 'component';

  return (
    <div className="ag-page ag-rizz-center">
      <section className="ag-hero ag-rizz-hero">
        <div>
          <span className="ag-eyebrow">
            Rizz.AI · application control center
          </span>
          <h1>{entity.metadata.title ?? 'Rizz.AI'}</h1>
          <p>
            React/nginx frontend → private Express API → Gemini. Follow the
            application from a verified build through review and delivery.
          </p>
          <p className="ag-muted">
            Catalog owner: {owner || 'not recorded'} · Source:{' '}
            <a href="https://github.com/YASHMAHAKAL/Rizz.AI">Rizz.AI</a>
          </p>
          {isComponent && (
            <a href="/catalog/default/system/rizz-ai/rizz-control-center">
              Open the full Rizz.AI system
            </a>
          )}
        </div>
      </section>

      <div className="ag-rizz-grid">
        <section className="ag-card">
          <span className="ag-eyebrow">Trusted builds</span>
          <h2>Paired releases</h2>
          {releases.state === 'loading' && <p>Reading release source…</p>}
          {releases.state === 'unavailable' && (
            <p role="status">Release evidence could not be read.</p>
          )}
          {releases.state === 'available' && (
            <p>{describeReleases(releases.value, releaseCount)}</p>
          )}
          <a href="/rizz-releases">Inspect release evidence</a>
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Target</span>
          <h2>EKS staging</h2>
          {capability.state === 'loading' && <p>Reading target…</p>}
          {capability.state === 'unavailable' && (
            <p role="status">Target configuration unavailable.</p>
          )}
          {capability.state === 'available' &&
            (capability.value.state === 'configured' &&
            capability.value.target ? (
              <p>
                {capability.value.target.clusterName} ·{' '}
                {capability.value.target.region} ·{' '}
                {capability.value.target.namespace}
                <br />
                Configured target. Deployment health requires an observation.
              </p>
            ) : (
              <p>Cloud target disabled. No EKS deployment is claimed.</p>
            ))}
          <a href="/rizz-deployments">Open governed deployments</a>
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Operate</span>
          <h2>Governed changes</h2>
          <p>
            Request a paired release, bounded replica change, verified rollback
            or staged retirement. Each uses Jev, exact snapshot review and a
            human decision before a draft PR.
          </p>
          {capability.state === 'available' &&
          capability.value.state === 'configured' &&
          capability.value.canSubmit ? (
            <div className="ag-rizz-actions">
              <a href="/rizz-deployments#paired-release-form">
                Propose paired release
              </a>
              <a href="/rizz-deployments#runtime-change-form">
                Propose replica change
              </a>
              <a href="/rizz-deployments#rollback-form">Propose rollback</a>
              {capability.value.canRetire && (
                <a href="/rizz-deployments#retirement-form">
                  Request retirement
                </a>
              )}
            </div>
          ) : (
            <a href="/rizz-deployments">Inspect governed deployments</a>
          )}
          <p className="ag-muted">
            Retirement needs two platform reviews and observed cleanup between
            the ingress and workload stages.
          </p>
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Access and review</span>
          <h2>Current cloud policy</h2>
          {capability.state === 'loading' && <p>Reading access…</p>}
          {capability.state === 'unavailable' && (
            <p role="status">Access policy unavailable.</p>
          )}
          {capability.state === 'available' &&
            (capability.value.state === 'configured' ? (
              <>
                <p>
                  Your access:{' '}
                  {capability.value.canSubmit
                    ? 'proposal submission enabled'
                    : 'read-only; not in an authorized submitter group'}
                  .
                </p>
                {capability.value.reviewPolicy ? (
                  <>
                    <p>
                      New-request reviewer groups:{' '}
                      <code>
                        {capability.value.reviewPolicy.reviewerGroups.join(
                          ' or ',
                        )}
                      </code>
                      .
                    </p>
                    <p>
                      {capability.value.reviewPolicy.memberOfReviewerGroup
                        ? 'You are a member of an eligible reviewer group.'
                        : 'You are not a member of an eligible reviewer group.'}{' '}
                      Membership alone never approves a proposal; a distinct
                      authorized user must review its exact digest. Existing
                      proposals retain their frozen reviewer policy.
                    </p>
                  </>
                ) : (
                  <p role="status">Reviewer policy unavailable.</p>
                )}
              </>
            ) : (
              <p>Cloud governance disabled; no review authority is active.</p>
            ))}
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Platform-only</span>
          <h2>Infrastructure controls</h2>
          <p>
            Foundation requests and exact Terraform plan review are separate
            from application GitOps changes. No request or review here starts an
            AWS deployment.
          </p>
          {infrastructure.state === 'loading' && <p>Checking access…</p>}
          {infrastructure.state === 'available' &&
            (infrastructure.value.state === 'request_and_review' ? (
              <a href="/rizz-infrastructure">Open infrastructure review</a>
            ) : (
              <p className="ag-muted">
                Infrastructure review is not configured.
              </p>
            ))}
          {infrastructure.state === 'unavailable' && (
            <p className="ag-muted">
              Platform-only details are unavailable to this account or reader.
            </p>
          )}
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Application map</span>
          <h2>Software and resources</h2>
          <ul>
            <li>
              <a href="/catalog/default/component/rizz-frontend">Frontend</a>
            </li>
            <li>
              <a href="/catalog/default/component/rizz-backend">Backend</a>
            </li>
            <li>
              <a href="/catalog/default/api/rizz-api">Rizz API</a>
            </li>
            <li>
              <a href="/catalog/default/resource/rizz-eks-staging">
                EKS target
              </a>
            </li>
            <li>
              <a href="/catalog/default/resource/rizz-staging-namespace">
                Staging namespace
              </a>
            </li>
            <li>
              <a href="/catalog/default/resource/rizz-ecr-registry">
                ECR registry
              </a>
            </li>
          </ul>
          <p className="ag-muted">
            Catalog resource records describe the platform target; they do not
            prove that AWS resources exist.
          </p>
        </section>

        <section className="ag-card">
          <span className="ag-eyebrow">Operate with context</span>
          <h2>Runbooks and architecture</h2>
          <p>
            Find the deployment, rollback, provider outage and retirement
            procedures alongside the application they support.
          </p>
          <ul>
            <li>
              <a href="/catalog/default/system/rizz-ai/docs">
                Open Rizz.AI TechDocs
              </a>
            </li>
            <li>
              <a href="https://github.com/YASHMAHAKAL/Rizz.AI/blob/master/docs/deploy-rollback.md">
                Deploy and rollback source runbook
              </a>
            </li>
            <li>
              <a href="https://github.com/YASHMAHAKAL/Rizz.AI/blob/master/docs/incidents.md">
                Incident response source runbook
              </a>
            </li>
          </ul>
          <p className="ag-muted">
            TechDocs availability depends on publishing the application source
            documentation; a catalog reference alone does not prove publication.
          </p>
        </section>
      </div>

      <section className="ag-card">
        <div className="ag-section-heading ag-rizz-queue-heading">
          <div>
            <span className="ag-eyebrow">Authorized activity</span>
            <h2>Recent cloud proposals</h2>
          </div>
          <button
            className="ag-button"
            type="button"
            onClick={() => setRefresh(value => value + 1)}
          >
            Refresh
          </button>
        </div>
        {proposals.state === 'loading' && <p>Reading requests…</p>}
        {proposals.state === 'unavailable' && (
          <p role="status">
            Cloud review data is disabled or unavailable for this account.
          </p>
        )}
        {proposals.state === 'available' && !visibleProposals.length && (
          <p>No cloud proposals visible to this account.</p>
        )}
        {visibleProposals.length > 0 && (
          <div className="ag-rizz-proposals">
            {visibleProposals.slice(0, 5).map(proposal => (
              <div className="ag-rizz-proposal" key={proposal.id}>
                <div>
                  <strong>{describeProposal(proposal)}</strong>
                  <small>
                    {proposal.status.replaceAll('_', ' ')} ·{' '}
                    {proposal.requester}
                    {proposal.viewerPermissions?.canReview
                      ? ' · awaiting your review'
                      : ''}
                  </small>
                </div>
                <div className="ag-rizz-proposal-actions">
                  <a
                    href={`/rizz-deployments?proposal=${encodeURIComponent(
                      proposal.id,
                    )}#review-queue`}
                  >
                    {proposal.viewerPermissions?.canReview
                      ? 'Review proposal'
                      : 'View proposal'}
                  </a>
                  <button
                    className="ag-button"
                    type="button"
                    aria-pressed={selectedProposal === proposal.id}
                    onClick={() => setSelectedProposal(proposal.id)}
                  >
                    Inspect delivery
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="ag-muted">
          Proposal state is the Scaffolder handoff. Delivery observation below
          independently checks merge, Argo and workloads; refreshing never
          deploys.
        </p>
        {selectedProposal &&
          selectedRecord &&
          (selectedRecord.snapshot.envelope.kind ===
            'rizz_cloud_retire_ingress' ||
          selectedRecord.snapshot.envelope.kind === 'rizz_cloud_retire_app' ? (
            <CloudRetirementPanel
              key={selectedProposal}
              proposalId={selectedProposal}
            />
          ) : (
            <CloudDeliveryPanel
              key={selectedProposal}
              proposalId={selectedProposal}
              handoff={selectedRecord}
            />
          ))}
      </section>

      <section className="ag-card">
        <span className="ag-eyebrow">Observed delivery</span>
        <h2>Verified deployment history</h2>
        <p className="ag-muted">
          Only a merged PR whose exact files were synced by Argo CD and whose
          workloads and smoke checks passed appears here. A CI build alone is
          not a deployment or rollback target.
        </p>
        {history.state === 'loading' && <p>Reading deployment history…</p>}
        {history.state === 'unavailable' && (
          <p role="status">Verified deployment history is unavailable.</p>
        )}
        {history.state === 'available' && history.value.length === 0 && (
          <p>No verified deployments recorded yet.</p>
        )}
        {history.state === 'available' && history.value.length > 0 && (
          <div className="ag-rizz-proposals">
            {history.value.slice(0, 5).map(record => (
              <div className="ag-rizz-proposal" key={record.proposalId}>
                <div>
                  <strong>
                    {record.sourceRelease?.releaseId ??
                      'Verified runtime change'}
                  </strong>
                  <small>
                    {record.verifiedAt} · frontend {record.frontendReplicas} ·
                    backend {record.backendReplicas} · merge{' '}
                    {record.mergeRevision.slice(0, 12)} · Argo{' '}
                    {record.argoRevision.slice(0, 12)}
                  </small>
                  <details className="ag-disclosure">
                    <summary>Verified image pair</summary>
                    <code>{record.frontendImage}</code>
                    <br />
                    <code>{record.backendImage}</code>
                  </details>
                </div>
                <a href={record.prUrl}>Reviewed pull request</a>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ag-card">
        <span className="ag-eyebrow">Deterministic evidence</span>
        <h2>Service readiness</h2>
        <p className="ag-muted">
          Checks are evidence-specific and separate from Jev. Historical
          delivery is not a claim of current health; unknown is not a pass.
        </p>
        {readiness.state === 'loading' && <p>Checking readiness evidence…</p>}
        {readiness.state === 'unavailable' && (
          <p role="status">Readiness evidence is unavailable.</p>
        )}
        {readiness.state === 'available' && (
          <>
            <small>
              {readiness.value.scope} · checked {readiness.value.checkedAt}
            </small>
            <div className="ag-rizz-proposals">
              {readiness.value.checks.map(item => (
                <div className="ag-rizz-proposal" key={item.id}>
                  <div>
                    <strong>
                      {item.title} · {item.state}
                    </strong>
                    <small>
                      {item.detail} Checked {item.checkedAt}.
                    </small>
                  </div>
                  <a href={item.evidenceUrl}>Evidence</a>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="ag-card">
        <span className="ag-eyebrow">Live telemetry</span>
        <h2>Backend metrics</h2>
        <p className="ag-muted">
          A private Kubernetes Service proxy samples one backend replica.
          Counters reset on restart; this is not an aggregate across replicas.
        </p>
        {metrics.state === 'loading' && <p>Reading backend metrics…</p>}
        {metrics.state === 'unavailable' && (
          <p role="status">Metrics source unavailable.</p>
        )}
        {metrics.state === 'available' &&
          metrics.value.state === 'unavailable' && (
            <p role="status">
              Metrics unavailable at {metrics.value.checkedAt}.
            </p>
          )}
        {metrics.state === 'available' &&
          metrics.value.state === 'observed' && (
            <div>
              <p>
                API requests {metrics.value.apiRequests} · errors{' '}
                {metrics.value.apiErrors} · mean latency{' '}
                {metrics.value.meanApiLatencySeconds === null
                  ? 'not measured'
                  : `${Math.round(
                      metrics.value.meanApiLatencySeconds * 1000,
                    )} ms`}
                .
              </p>
              <p>
                Provider calls {metrics.value.providerCalls}/
                {metrics.value.providerCallLimit}
                {' · '}in flight {metrics.value.providerInFlight}.
              </p>
              <p>
                Provider outcomes:{' '}
                {Object.entries(metrics.value.providerOutcomes)
                  .map(([outcome, count]) => `${outcome} ${count}`)
                  .join(' · ') || 'none recorded'}
                .
              </p>
              <small>
                Sampled {metrics.value.checkedAt} · one backend replica
              </small>
            </div>
          )}
      </section>
    </div>
  );
}
