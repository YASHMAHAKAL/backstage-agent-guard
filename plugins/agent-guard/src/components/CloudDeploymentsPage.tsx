import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { Container, Header } from '@backstage/ui';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { JevPanel } from './ProposalsPage/JevPanel';
import { SemanticResult, humanize, statusTone } from './ProposalsPage/model';
import './ProposalsPage/ProposalsPage.css';
import { CloudDeliveryPanel } from './CloudDeliveryPanel';
import { CloudRetirementPanel } from './CloudRetirementPanel';

type Release = {
  releaseId: string;
  recordDigest: string;
  sourceCommit: string;
  expiresAt: string;
  eligibleForProposal: boolean;
};
type VerifiedDeployment = {
  proposalId: string;
  operation:
    | 'rizz_cloud_release'
    | 'rizz_cloud_runtime_change'
    | 'rizz_cloud_rollback';
  verifiedAt: string;
  frontendReplicas: number;
  backendReplicas: number;
  sourceRelease?: { releaseId: string };
};
type Capability = {
  state: 'disabled' | 'configured';
  canSubmit: boolean;
  canRetire?: boolean;
  target?: {
    id: string;
    clusterName: string;
    namespace: string;
    owner: string;
    region: string;
  };
};
type CloudProposal = {
  id: string;
  status: string;
  requester: string;
  reasonCodes: string[];
  semantic: SemanticResult;
  viewerPermissions: { canReview: boolean };
  currentState: {
    state: 'absent' | 'present' | 'retiring' | 'retired';
    frontendImage?: string;
    backendImage?: string;
    frontendReplicas?: number;
    backendReplicas?: number;
    geminiModel?: string;
  };
  snapshot: {
    digest: string;
    files: Array<{ path: string; content: string; sha256: string }>;
    deletePaths?: string[];
    envelope: {
      kind:
        | 'rizz_cloud_release'
        | 'rizz_cloud_runtime_change'
        | 'rizz_cloud_rollback'
        | 'rizz_cloud_retire_ingress'
        | 'rizz_cloud_retire_app';
      declaredIntent: string;
      submissionChannel: string;
      intentSource: string;
      policyVersion: string;
      reviewerGroups?: string[];
      rollbackSource?: {
        verifiedDeploymentId: string;
        verifiedAt: string;
        snapshotDigest: string;
      };
      template?: { id: string; version: string; digest: string };
      reason?: string;
      deletedPaths?: string[];
      cleanupEvidence?: {
        checkedAt: string;
        ingressAbsent: true;
        albAbsent: true;
        targetGroupsAbsent: true;
      };
      inputs?: {
        releaseId: string;
        frontendReplicas: number;
        backendReplicas: number;
      };
      patch?: { frontendReplicas?: number; backendReplicas?: number };
      before?: {
        frontendReplicas: number;
        backendReplicas: number;
        frontendImage: string;
        backendImage: string;
      };
      after?: {
        frontendReplicas: number;
        backendReplicas: number;
        frontendImage: string;
        backendImage: string;
      };
      changedFields?: string[];
      target: {
        accountId: string;
        region: string;
        clusterName: string;
        namespace: string;
        owner: string;
        gitopsRepository: string;
        gitopsBranch: string;
        gitopsPath: string;
        argoApplication: string;
        ingress: {
          hostname: string;
          operatorCidr: string;
          certificateArn: string;
          certificateSha256: string;
        };
      };
      gitopsBase: {
        revision: string;
        files: Array<{ name: string; sha256: string }>;
      };
      release?: {
        recordDigest: string;
        record: {
          source: { commit: string };
          expiresAt: string;
          images: Record<
            'frontend' | 'backend',
            { repository: string; digest: string }
          >;
        };
      };
    };
  };
  decision?: { reviewer: string; at: string; decision: string; digest: string };
  execution?: {
    state: string;
    taskId?: string;
    prUrl?: string;
    errorCode?: string;
  };
  audit: Array<{ event: string; actor: string; at: string; digest: string }>;
};
const endpoint = 'plugin://agent-guard/rizz';
type Workflow = 'release' | 'runtime' | 'rollback' | 'retirement';
const workflowLabels: Record<Workflow, string> = {
  release: 'Paired release',
  runtime: 'Change replicas',
  rollback: 'Rollback',
  retirement: 'Retire application',
};

function manifestPreview(content: string): { format: string; text: string } {
  try {
    const document = JSON.parse(content);
    if (document && typeof document === 'object' && !Array.isArray(document)) {
      return {
        format: 'YAML',
        text: stringifyYaml(document, { lineWidth: 0 }),
      };
    }
  } catch {
    // Existing GitOps files may already be YAML. Show those exact bytes below.
  }
  return { format: 'manifest', text: content };
}

function ManifestFilePreview({
  file,
}: {
  file: CloudProposal['snapshot']['files'][number];
}) {
  const preview = manifestPreview(file.content);
  return (
    <details className="ag-file">
      <summary>
        <span aria-hidden="true">▸</span>
        <span>{file.path}</span>
        <small>View {preview.format}</small>
      </summary>
      <div className="ag-file__body">
        <p className="ag-muted">
          {preview.format === 'YAML'
            ? 'Formatted YAML for reading. The exact approved bytes are available below.'
            : 'Exact approved manifest bytes.'}
        </p>
        <pre>{preview.text}</pre>
        {preview.format === 'YAML' && (
          <details className="ag-disclosure">
            <summary>Exact approved bytes</summary>
            <pre>{file.content}</pre>
          </details>
        )}
        <span>SHA-256 of exact approved bytes</span>
        <code>{file.sha256}</code>
      </div>
    </details>
  );
}

function proposalLabel(proposal: CloudProposal) {
  const { envelope } = proposal.snapshot;
  if (envelope.kind === 'rizz_cloud_retire_ingress')
    return 'Retirement: remove ingress';
  if (envelope.kind === 'rizz_cloud_retire_app')
    return 'Retirement: remove app resources';
  if (envelope.kind === 'rizz_cloud_runtime_change')
    return `Runtime: ${envelope.changedFields?.join(', ')}`;
  if (envelope.kind === 'rizz_cloud_rollback')
    return `Rollback: ${envelope.inputs?.releaseId}`;
  return envelope.inputs?.releaseId;
}

function reviewDescription(
  kind: CloudProposal['snapshot']['envelope']['kind'],
) {
  if (kind === 'rizz_cloud_runtime_change')
    return 'before/after replicas, preserved fields';
  if (kind === 'rizz_cloud_rollback')
    return 'healthy deployment record, restored image pair and protected fields';
  if (kind === 'rizz_cloud_retire_ingress' || kind === 'rizz_cloud_retire_app')
    return 'retirement reason, deleted paths, remaining files and retained foundation';
  return 'paired images';
}
function isRetirement(kind: CloudProposal['snapshot']['envelope']['kind']) {
  return (
    kind === 'rizz_cloud_retire_ingress' || kind === 'rizz_cloud_retire_app'
  );
}

export function CloudDeploymentsPage() {
  const { fetch } = useApi(fetchApiRef);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [history, setHistory] = useState<VerifiedDeployment[]>([]);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [queue, setQueue] = useState<CloudProposal[]>([]);
  const [selected, setSelected] = useState<CloudProposal | null>(null);
  const [creating, setCreating] = useState(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('new') === '1',
  );
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow>('release');
  const [queueFilter, setQueueFilter] = useState<'all' | 'review'>('all');
  const [queueQuery, setQueueQuery] = useState('');
  const selectedId = useRef(
    typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('proposal') ?? '',
  );
  const [releaseId, setReleaseId] = useState('');
  const [intent, setIntent] = useState('');
  const [frontendReplicas, setFrontendReplicas] = useState(1);
  const [backendReplicas, setBackendReplicas] = useState(1);
  const [runtimeIntent, setRuntimeIntent] = useState('');
  const [runtimeFrontend, setRuntimeFrontend] = useState('');
  const [runtimeBackend, setRuntimeBackend] = useState('');
  const [rollbackId, setRollbackId] = useState('');
  const [rollbackIntent, setRollbackIntent] = useState('');
  const [retireIntent, setRetireIntent] = useState('');
  const [retireReason, setRetireReason] = useState('');
  const [retirePreview, setRetirePreview] = useState<{
    inputKey: string;
    stage: 'rizz_cloud_retire_ingress' | 'rizz_cloud_retire_app';
    baseRevision: string;
    changedFiles: Array<{ path: string; sha256: string }>;
    deletedPaths: string[];
    cleanupEvidence?: { checkedAt: string };
    retainedFoundation: string[];
  } | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<{
    inputKey: string;
    baseRevision: string;
    before: {
      frontendImage: string;
      backendImage: string;
      frontendReplicas: number;
      backendReplicas: number;
    };
    after: {
      frontendImage: string;
      backendImage: string;
      frontendReplicas: number;
      backendReplicas: number;
    };
    changedFiles: Array<{ path: string; sha256: string }>;
  } | null>(null);
  const [runtimePreview, setRuntimePreview] = useState<{
    inputKey: string;
    state: 'preview' | 'no_change';
    baseRevision: string;
    before: { frontendReplicas: number; backendReplicas: number };
    after: { frontendReplicas: number; backendReplicas: number };
    changedFields: string[];
    changedFiles: Array<{ path: string; sha256: string }>;
  } | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [releaseWarning, setReleaseWarning] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setRequiresRefresh(false);
    setError('');
    setSelected(null);
    setReviewConfirmed(false);
    setReleases([]);
    setHistory([]);
    setHistoryUnavailable(false);
    setQueue([]);
    setCapability(null);
    setReleaseId('');
    setReleaseWarning('');
    setRuntimePreview(null);
    setRollbackPreview(null);
    setRetirePreview(null);
    const read = async (path: string) => {
      const response = await fetch(`${endpoint}/${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Cloud portal unavailable');
      return response.json();
    };
    (async () => {
      try {
        const caps = (await read('capabilities')) as Capability;
        if (
          !['disabled', 'configured'].includes(caps.state) ||
          (caps.state === 'configured' && !caps.target)
        )
          throw new Error('Invalid cloud capability');
        if (!active) return;
        setCapability(caps);
        if (caps.state !== 'configured') return;
        // A release-source outage must not hide existing review requests.
        const [listing, proposals, deployments] = await Promise.all([
          read('releases').catch(() => null),
          read('proposals'),
          read('verified-deployments').catch(() => null),
        ]);
        if (!active) return;
        if (!Array.isArray(proposals.items))
          throw new Error('Invalid cloud queue');
        const available =
          listing?.state === 'available' && Array.isArray(listing.items)
            ? (listing.items as Release[]).filter(
                release =>
                  release.eligibleForProposal &&
                  Date.parse(release.expiresAt) > Date.now(),
              )
            : [];
        setReleases(available);
        if (listing?.state !== 'available')
          setReleaseWarning(
            'Trusted releases unavailable or unconfigured. Fixture evidence cannot be proposed.',
          );
        setQueue(proposals.items);
        setHistory(
          Array.isArray(deployments?.items)
            ? (deployments.items as VerifiedDeployment[])
            : [],
        );
        setHistoryUnavailable(deployments === null);
        const previous = proposals.items.find(
          (p: CloudProposal) => p.id === selectedId.current,
        );
        if (previous) setSelected(previous);
      } catch {
        if (active) {
          setError(
            'Cloud configuration or review data unavailable. Refresh before taking action.',
          );
          setSelected(null);
          setCapability(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [fetch, refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      inFlight.current ||
      capability?.state !== 'configured' ||
      !capability.canSubmit ||
      loading ||
      requiresRefresh
    )
      return;
    const release = releases.find(value => value.releaseId === releaseId);
    if (!release || Date.parse(release.expiresAt) <= Date.now()) {
      setError('Select a verified, unexpired release.');
      return;
    }
    if (intent.trim().length < 12 || intent.trim().length > 1000) {
      setError('Describe your intent in 12–1000 characters.');
      return;
    }
    if (
      ![frontendReplicas, backendReplicas].every(
        value => Number.isInteger(value) && value >= 1 && value <= 2,
      )
    ) {
      setError('Both replica counts must be integers from 1 to 2.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setSelected(null);
    setReviewConfirmed(false);
    try {
      const response = await fetch(`${endpoint}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          declaredIntent: intent.trim(),
          templateId: 'deploy-rizz-ai',
          inputs: {
            targetId: capability.target!.id,
            releaseId,
            releaseRecordDigest: release.recordDigest,
            frontendReplicas,
            backendReplicas,
          },
        }),
      });
      if (!response.ok) throw new Error('Submission failed');
      const created = (await response.json()) as CloudProposal;
      selectedId.current = created.id;
      setQueue(current => [created, ...current]);
      setSelected(created);
      setIntent('');
    } catch {
      setRequiresRefresh(true);
      setError(
        'Could not confirm submission. Refresh the queue before retrying; no automatic retry was made.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function runtimeInput() {
    if (!capability?.target) throw new Error('Cloud target unavailable.');
    const patch: { frontendReplicas?: number; backendReplicas?: number } = {};
    if (runtimeFrontend !== '')
      patch.frontendReplicas = Number(runtimeFrontend);
    if (runtimeBackend !== '') patch.backendReplicas = Number(runtimeBackend);
    if (
      runtimeIntent.trim().length < 12 ||
      runtimeIntent.trim().length > 1000 ||
      Object.keys(patch).length === 0 ||
      !Object.values(patch).every(
        value => Number.isInteger(value) && value >= 1 && value <= 2,
      )
    )
      throw new Error(
        'Enter an intent and at least one replica count from 1 to 2.',
      );
    return {
      operation: 'runtime_change',
      declaredIntent: runtimeIntent.trim(),
      targetId: capability.target.id,
      patch,
    };
  }
  async function runtimeAction(action: 'preview' | 'submit') {
    if (inFlight.current || !capability?.canSubmit || requiresRefresh) return;
    let input: ReturnType<typeof runtimeInput>;
    try {
      input = runtimeInput();
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    const inputKey = JSON.stringify(input);
    if (
      action === 'submit' &&
      (runtimePreview?.state !== 'preview' ||
        runtimePreview.inputKey !== inputKey)
    ) {
      setError('Preview this exact runtime change before submitting.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${endpoint}/runtime/${action === 'preview' ? 'preview' : 'proposals'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error('Runtime request failed');
      if (action === 'preview') {
        setRuntimePreview({ ...(await response.json()), inputKey });
      } else {
        const created = (await response.json()) as CloudProposal;
        selectedId.current = created.id;
        setQueue(current => [created, ...current]);
        setSelected(created);
        setRuntimePreview(null);
        setRuntimeIntent('');
        setRuntimeFrontend('');
        setRuntimeBackend('');
      }
    } catch {
      if (action === 'submit') setRequiresRefresh(true);
      setError(
        action === 'submit'
          ? 'Could not confirm submission. Refresh the queue before retrying; no automatic retry was made.'
          : 'Runtime preview unavailable. Check the existing GitOps deployment and try again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function rollbackAction(action: 'preview' | 'submit') {
    if (inFlight.current || !capability?.canSubmit || requiresRefresh) return;
    if (
      !history.some(
        item =>
          item.proposalId === rollbackId &&
          item.operation === 'rizz_cloud_release',
      ) ||
      rollbackIntent.trim().length < 12 ||
      rollbackIntent.trim().length > 1000
    ) {
      setError(
        'Select a verified release deployment and describe the rollback intent.',
      );
      return;
    }
    const input = {
      operation: 'rollback',
      declaredIntent: rollbackIntent.trim(),
      targetId: capability.target!.id,
      verifiedDeploymentId: rollbackId,
    };
    const inputKey = JSON.stringify(input);
    if (action === 'submit' && rollbackPreview?.inputKey !== inputKey) {
      setError('Preview this exact rollback before submitting.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${endpoint}/rollback/${
          action === 'preview' ? 'preview' : 'proposals'
        }`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error('Rollback request failed');
      if (action === 'preview') {
        setRollbackPreview({ ...(await response.json()), inputKey });
      } else {
        const created = (await response.json()) as CloudProposal;
        selectedId.current = created.id;
        setQueue(current => [created, ...current]);
        setSelected(created);
        setRollbackPreview(null);
        setRollbackIntent('');
        setRollbackId('');
      }
    } catch {
      if (action === 'submit') setRequiresRefresh(true);
      setError(
        action === 'submit'
          ? 'Could not confirm rollback submission. Refresh the queue before retrying.'
          : 'Rollback preview unavailable. The retained release, recipe or current protected configuration may be incompatible.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function retirementAction(action: 'preview' | 'submit') {
    if (inFlight.current || !capability?.canSubmit || requiresRefresh) return;
    const input = {
      targetId: capability.target!.id,
      declaredIntent: retireIntent.trim(),
      reason: retireReason.trim(),
    };
    if (
      input.declaredIntent.length < 20 ||
      input.declaredIntent.length > 2000 ||
      input.reason.length < 20 ||
      input.reason.length > 1000
    ) {
      setError(
        'Describe the retirement intent and reason in at least 20 characters each.',
      );
      return;
    }
    const inputKey = JSON.stringify(input);
    if (action === 'submit' && retirePreview?.inputKey !== inputKey) {
      setError('Preview this exact retirement stage before submitting.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${endpoint}/retirement/${
          action === 'preview' ? 'preview' : 'proposals'
        }`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error('Retirement request failed');
      if (action === 'preview') {
        setRetirePreview({ ...(await response.json()), inputKey });
      } else {
        const created = (await response.json()) as CloudProposal;
        selectedId.current = created.id;
        setQueue(current => [created, ...current]);
        setSelected(created);
        setRetirePreview(null);
        setRetireIntent('');
        setRetireReason('');
      }
    } catch {
      if (action === 'submit') setRequiresRefresh(true);
      setError(
        action === 'submit'
          ? 'Could not confirm retirement submission. Refresh the queue before retrying.'
          : 'Retirement preview unavailable. Check the approved ingress stage, GitOps base and cleanup evidence.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function decide(decision: 'approve' | 'reject') {
    if (
      inFlight.current ||
      !selected?.viewerPermissions.canReview ||
      loading ||
      requiresRefresh ||
      (decision === 'approve' && !reviewConfirmed)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${endpoint}/proposals/${selected.id}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, digest: selected.snapshot.digest }),
        },
      );
      if (!response.ok) throw new Error('Decision rejected');
      const updated = (await response.json()) as CloudProposal;
      setSelected(updated);
      setQueue(current =>
        current.map(p => (p.id === updated.id ? updated : p)),
      );
      setReviewConfirmed(false);
    } catch {
      setRequiresRefresh(true);
      setSelected(null);
      setReviewConfirmed(false);
      setError(
        'Could not confirm the decision. Evidence or permissions may have changed. Refresh before retrying.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const envelope = selected?.snapshot.envelope;
  const reviewCount = queue.filter(
    item => item.viewerPermissions.canReview,
  ).length;
  const visibleQueue = queue
    .filter(item => queueFilter === 'all' || item.viewerPermissions.canReview)
    .filter(item =>
      `${proposalLabel(item)} ${item.requester} ${item.id}`
        .toLowerCase()
        .includes(queueQuery.trim().toLowerCase()),
    );
  function startNewRequest() {
    selectedId.current = '';
    setSelected(null);
    setReviewConfirmed(false);
    setCreating(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('proposal');
    url.hash = '';
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  }
  return (
    <>
      <Header title="Rizz.AI deployments" />
      <Container>
        <div className="ag-page ag-cloud-page">
          <section className="ag-hero">
            <div>
              <span className="ag-eyebrow">Agent Guard · EKS staging</span>
              <h1>Rizz.AI deployments.</h1>
              <p>
                Compare intent with the exact GitOps change, approve a frozen
                snapshot, and follow delivery from Scaffolder to Argo CD.
              </p>
              <p className="ag-kind-back">
                <a href="/agent-guard">← All governed requests</a>
              </p>
              <a href="/rizz-releases">Browse release evidence</a>
            </div>
            <div className="ag-hero__actions">
              <button
                className="ag-button ag-button--hero"
                type="button"
                disabled={busy || loading}
                onClick={() => setRefresh(value => value + 1)}
              >
                <span aria-hidden="true">↻</span> Refresh
              </button>
              {capability?.state === 'configured' && capability.canSubmit && (
                <button
                  className="ag-button ag-button--primary"
                  type="button"
                  aria-expanded={creating && !selected}
                  aria-controls="rizz-new-request"
                  onClick={() => {
                    if (creating && !selected) setCreating(false);
                    else startNewRequest();
                  }}
                >
                  {creating && !selected ? 'Close form' : '+ New proposal'}
                </button>
              )}
            </div>
          </section>
          <div className="ag-cloud-status">
            {loading && <p role="status">Loading cloud configuration…</p>}
            {error && (
              <div className="ag-notice ag-notice--error" role="alert">
                {error}
              </div>
            )}
            {!loading && capability?.state === 'disabled' && (
              <div className="ag-notice" role="status">
                Cloud releases are disabled. No EKS target is connected; the
                Kind demo remains available.
              </div>
            )}
            {capability?.state === 'configured' && (
              <p className="ag-muted">
                Configured target: {capability.target?.clusterName} ·{' '}
                {capability.target?.region} · namespace{' '}
                {capability.target?.namespace}. Configuration is not readiness
                or deployment verification.
              </p>
            )}
          </div>
          {!loading && capability?.state === 'configured' && (
            <div className="ag-overview" aria-label="Cloud proposal overview">
              <div>
                <span>Visible proposals</span>
                <strong>{queue.length}</strong>
                <small>Within your access scope</small>
              </div>
              <div>
                <span>Ready for your review</span>
                <strong>{reviewCount}</strong>
                <small>Distinct authorized reviewer</small>
              </div>
              <div>
                <span>Verified deployments</span>
                <strong>{history.length}</strong>
                <small>Observed completed rollouts</small>
              </div>
            </div>
          )}
          {!loading && capability?.state === 'configured' && (
            <>
              {capability.canSubmit && creating && !selected && (
                <section
                  id="rizz-new-request"
                  className="ag-card ag-create ag-cloud-create"
                >
                  <div className="ag-section-heading">
                    <div>
                      <span className="ag-eyebrow">New governed request</span>
                      <h2>Create a Rizz.AI proposal</h2>
                      <p className="ag-muted">
                        Choose a bounded operation. Submission requests review;
                        it does not deploy or open a GitOps PR.
                      </p>
                    </div>
                  </div>
                  <div className="ag-create__section-heading">
                    <span>01</span>
                    <div>
                      <h3>Choose an operation</h3>
                      <p>
                        Each operation has its own verified inputs and checks.
                      </p>
                    </div>
                  </div>
                  <div
                    className="ag-create__templates"
                    role="group"
                    aria-label="Request type"
                  >
                    {(Object.keys(workflowLabels) as Workflow[]).map(
                      workflow => (
                        <button
                          className={`ag-create__template ${
                            activeWorkflow === workflow
                              ? 'ag-create__template--selected'
                              : ''
                          }`}
                          type="button"
                          key={workflow}
                          aria-pressed={activeWorkflow === workflow}
                          onClick={() => setActiveWorkflow(workflow)}
                        >
                          <strong>{workflowLabels[workflow]}</strong>
                          <small>
                            {workflow === 'release'
                              ? 'Verified image pair'
                              : workflow === 'runtime'
                              ? 'Bounded replica change'
                              : workflow === 'rollback'
                              ? 'Previously healthy release'
                              : 'Staged application cleanup'}
                          </small>
                        </button>
                      ),
                    )}
                  </div>
                  {capability.canSubmit ? (
                    <section
                      id="paired-release-form"
                      className="ag-cloud-form"
                      aria-labelledby="rizz-create-title"
                      hidden={
                        !creating ||
                        Boolean(selected) ||
                        activeWorkflow !== 'release'
                      }
                    >
                      <span className="ag-eyebrow">
                        02 · Describe the request
                      </span>
                      <h2 id="rizz-create-title">Propose a paired release</h2>
                      <p>
                        Frontend: internet-facing HTTPS ALB restricted to one
                        operator /32, temporary self-signed certificate.
                        Backend: ClusterIP only. Application owner: rizz-team;
                        platform target owner: platform-team. No database.
                      </p>
                      {releaseWarning && <p role="status">{releaseWarning}</p>}
                      <form onSubmit={submit} noValidate>
                        <fieldset
                          disabled={
                            busy ||
                            loading ||
                            requiresRefresh ||
                            !releases.length
                          }
                        >
                          <legend className="ag-visually-hidden">
                            Cloud proposal details
                          </legend>
                          <div className="ag-create__fields">
                            <label className="ag-create__field ag-create__field--wide">
                              <span>Verified release</span>
                              <select
                                value={releaseId}
                                onChange={event =>
                                  setReleaseId(event.target.value)
                                }
                              >
                                <option value="">
                                  Choose a verified release
                                </option>
                                {releases.map(release => (
                                  <option
                                    key={release.releaseId}
                                    value={release.releaseId}
                                  >
                                    {release.releaseId}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="ag-create__field ag-create__field--wide">
                              <span>Declared intent</span>
                              <textarea
                                aria-label="Declared intent"
                                aria-describedby="rizz-intent-help"
                                rows={3}
                                maxLength={1000}
                                value={intent}
                                onChange={event =>
                                  setIntent(event.target.value)
                                }
                                placeholder="Describe the paired release, EKS staging, frontend exposure and private backend."
                              />
                              <small>
                                Authenticated submission, not cryptographic
                                proof of original user words.
                              </small>
                            </label>
                            <label className="ag-create__field">
                              <span>Frontend replicas</span>
                              <input
                                type="number"
                                min={1}
                                max={2}
                                step={1}
                                value={frontendReplicas}
                                onChange={event =>
                                  setFrontendReplicas(
                                    Number(event.target.value),
                                  )
                                }
                              />
                            </label>
                            <label className="ag-create__field">
                              <span>Backend replicas</span>
                              <input
                                type="number"
                                min={1}
                                max={2}
                                step={1}
                                value={backendReplicas}
                                onChange={event =>
                                  setBackendReplicas(Number(event.target.value))
                                }
                              />
                            </label>
                          </div>
                          <button
                            className="ag-button ag-button--primary"
                            type="submit"
                            disabled={busy || !releaseId}
                          >
                            {busy ? 'Working…' : 'Submit cloud proposal'}
                          </button>
                        </fieldset>
                      </form>
                      {!releases.length && (
                        <p>
                          No verified, unexpired release is available. No
                          fixture or mutable image fallback.
                        </p>
                      )}
                    </section>
                  ) : (
                    <section className="ag-card">
                      <p>
                        You can inspect authorized requests, but are not in a
                        configured submitter group.
                      </p>
                    </section>
                  )}
                  {capability.canSubmit && (
                    <section
                      id="runtime-change-form"
                      className="ag-cloud-form"
                      aria-labelledby="rizz-runtime-title"
                      hidden={
                        !creating ||
                        Boolean(selected) ||
                        activeWorkflow !== 'runtime'
                      }
                    >
                      <span className="ag-eyebrow">
                        02 · Describe the request
                      </span>
                      <h2 id="rizz-runtime-title">Change runtime replicas</h2>
                      <p>
                        Choose only the workload you want to scale. The existing
                        images, model, routing and exposure remain frozen.
                        Preview reads the pinned GitOps baseline; submission
                        still requires Jev and a distinct eligible application
                        or platform reviewer.
                      </p>
                      <div className="ag-create__fields">
                        <label className="ag-create__field ag-create__field--wide">
                          <span>Runtime change intent</span>
                          <textarea
                            rows={3}
                            maxLength={1000}
                            value={runtimeIntent}
                            onChange={event => {
                              setRuntimeIntent(event.target.value);
                              setRuntimePreview(null);
                            }}
                            placeholder="Increase the backend to 2 replicas in EKS staging; leave the frontend unchanged."
                          />
                        </label>
                        <label className="ag-create__field">
                          <span>Frontend replicas · optional</span>
                          <input
                            type="number"
                            min={1}
                            max={2}
                            step={1}
                            value={runtimeFrontend}
                            onChange={event => {
                              setRuntimeFrontend(event.target.value);
                              setRuntimePreview(null);
                            }}
                          />
                        </label>
                        <label className="ag-create__field">
                          <span>Backend replicas · optional</span>
                          <input
                            type="number"
                            min={1}
                            max={2}
                            step={1}
                            value={runtimeBackend}
                            onChange={event => {
                              setRuntimeBackend(event.target.value);
                              setRuntimePreview(null);
                            }}
                          />
                        </label>
                      </div>
                      <div className="ag-create__actions">
                        <button
                          className="ag-button"
                          type="button"
                          disabled={busy || requiresRefresh}
                          onClick={() => runtimeAction('preview')}
                        >
                          Preview exact change
                        </button>
                        <button
                          className="ag-button ag-button--primary"
                          type="button"
                          disabled={
                            busy ||
                            requiresRefresh ||
                            runtimePreview?.state !== 'preview'
                          }
                          onClick={() => runtimeAction('submit')}
                        >
                          Submit runtime proposal
                        </button>
                      </div>
                      {runtimePreview && (
                        <div className="ag-notice" role="status">
                          <strong>
                            {runtimePreview.state === 'no_change'
                              ? 'No change'
                              : 'Preview at pinned revision'}
                          </strong>{' '}
                          <code>{runtimePreview.baseRevision}</code>
                          <p>
                            Frontend: {runtimePreview.before.frontendReplicas} →{' '}
                            {runtimePreview.after.frontendReplicas}; backend:{' '}
                            {runtimePreview.before.backendReplicas} →{' '}
                            {runtimePreview.after.backendReplicas}.
                          </p>
                          <p>
                            Changed fields:{' '}
                            {runtimePreview.changedFields.join(', ') || 'none'}
                          </p>
                          {runtimePreview.changedFiles.map(file => (
                            <p key={file.path}>
                              <code>{file.path}</code> ·{' '}
                              <code>{file.sha256}</code>
                            </p>
                          ))}
                          <small>
                            This preview neither approves nor creates a PR.
                            Submission re-reads the current baseline.
                          </small>
                        </div>
                      )}
                    </section>
                  )}
                  {capability.canSubmit && capability.canRetire && (
                    <section
                      id="retirement-form"
                      className="ag-cloud-form"
                      aria-labelledby="rizz-retirement-title"
                      hidden={
                        !creating ||
                        Boolean(selected) ||
                        activeWorkflow !== 'retirement'
                      }
                    >
                      <span className="ag-eyebrow">
                        02 · Describe the request
                      </span>
                      <h2 id="rizz-retirement-title">
                        Request staging retirement
                      </h2>
                      <p>
                        The first reviewed PR removes ingress. After it is
                        merged, Argo removes the ingress, and the ALB and target
                        groups are independently absent, a second reviewed PR
                        removes the app resources. EKS, VPC, ECR, Terraform
                        state and the AWS runtime secret remain platform
                        resources.
                      </p>
                      <div className="ag-create__fields">
                        <label className="ag-create__field ag-create__field--wide">
                          <span>Declared retirement intent</span>
                          <textarea
                            rows={3}
                            maxLength={2000}
                            value={retireIntent}
                            onChange={event => {
                              setRetireIntent(event.target.value);
                              setRetirePreview(null);
                            }}
                            placeholder="Retire only the Rizz.AI staging application, beginning with its public ingress."
                          />
                        </label>
                        <label className="ag-create__field ag-create__field--wide">
                          <span>Reason</span>
                          <textarea
                            rows={2}
                            maxLength={1000}
                            value={retireReason}
                            onChange={event => {
                              setRetireReason(event.target.value);
                              setRetirePreview(null);
                            }}
                            placeholder="The short staging demo is complete and its application access should be removed."
                          />
                        </label>
                      </div>
                      <div className="ag-create__actions">
                        <button
                          className="ag-button"
                          type="button"
                          disabled={busy || requiresRefresh}
                          onClick={() => retirementAction('preview')}
                        >
                          Preview next stage
                        </button>
                        <button
                          className="ag-button ag-button--primary"
                          type="button"
                          disabled={busy || requiresRefresh || !retirePreview}
                          onClick={() => retirementAction('submit')}
                        >
                          Submit retirement proposal
                        </button>
                      </div>
                      {retirePreview && (
                        <div
                          className="ag-notice ag-notice--warning"
                          role="status"
                        >
                          <strong>
                            {retirePreview.stage === 'rizz_cloud_retire_ingress'
                              ? 'Stage 1: remove ingress'
                              : 'Stage 2: remove remaining app resources'}
                          </strong>
                          <p>
                            Reviewed base:{' '}
                            <code>{retirePreview.baseRevision}</code>
                          </p>
                          <p>
                            Delete: {retirePreview.deletedPaths.join(', ')}.
                          </p>
                          <p>
                            Replace:{' '}
                            {retirePreview.changedFiles
                              .map(file => file.path)
                              .join(', ')}
                            .
                          </p>
                          {retirePreview.cleanupEvidence && (
                            <p>
                              Ingress, ALB and target groups absent at{' '}
                              {retirePreview.cleanupEvidence.checkedAt}.
                            </p>
                          )}
                          <p>
                            Retained:{' '}
                            {retirePreview.retainedFoundation.join(', ')}.
                          </p>
                          <small>
                            Preview is read-only. Submission rechecks the exact
                            GitOps base and cleanup conditions before review.
                          </small>
                        </div>
                      )}
                    </section>
                  )}
                  {capability.canSubmit && !capability.canRetire && (
                    <section
                      className="ag-cloud-form"
                      hidden={
                        !creating ||
                        Boolean(selected) ||
                        activeWorkflow !== 'retirement'
                      }
                    >
                      <h2>Retirement observation unavailable</h2>
                      <p>
                        Staged retirement becomes available after the trusted
                        Argo observer and read-only cleanup inventory are
                        configured.
                      </p>
                    </section>
                  )}
                  {capability.canSubmit && (
                    <section
                      id="rollback-form"
                      className="ag-cloud-form"
                      aria-labelledby="rizz-rollback-title"
                      hidden={
                        !creating ||
                        Boolean(selected) ||
                        activeWorkflow !== 'rollback'
                      }
                    >
                      <span className="ag-eyebrow">
                        02 · Describe the request
                      </span>
                      <h2 id="rizz-rollback-title">Propose a rollback</h2>
                      <p>
                        Choose a previously verified paired release. Preview
                        checks the retained artifact, current GitOps bytes and
                        unchanged routing, secrets and recipe. Approval opens a
                        draft PR; it does not directly revert or sync the
                        cluster.
                      </p>
                      {historyUnavailable && (
                        <p role="status">Deployment history unavailable.</p>
                      )}
                      <div className="ag-create__fields">
                        <label className="ag-create__field ag-create__field--wide">
                          <span>Previously verified release deployment</span>
                          <select
                            value={rollbackId}
                            onChange={event => {
                              setRollbackId(event.target.value);
                              setRollbackPreview(null);
                            }}
                          >
                            <option value="">
                              Choose a healthy deployment
                            </option>
                            {history
                              .filter(
                                item => item.operation === 'rizz_cloud_release',
                              )
                              .map(item => (
                                <option
                                  key={item.proposalId}
                                  value={item.proposalId}
                                >
                                  {item.sourceRelease?.releaseId ??
                                    item.proposalId}{' '}
                                  · {item.verifiedAt}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="ag-create__field ag-create__field--wide">
                          <span>Rollback intent</span>
                          <textarea
                            rows={3}
                            maxLength={1000}
                            value={rollbackIntent}
                            onChange={event => {
                              setRollbackIntent(event.target.value);
                              setRollbackPreview(null);
                            }}
                            placeholder="Restore the previously healthy paired Rizz.AI release in EKS staging."
                          />
                        </label>
                      </div>
                      <div className="ag-create__actions">
                        <button
                          className="ag-button"
                          type="button"
                          disabled={busy || requiresRefresh || !rollbackId}
                          onClick={() => rollbackAction('preview')}
                        >
                          Preview rollback
                        </button>
                        <button
                          className="ag-button ag-button--primary"
                          type="button"
                          disabled={busy || requiresRefresh || !rollbackPreview}
                          onClick={() => rollbackAction('submit')}
                        >
                          Submit rollback proposal
                        </button>
                      </div>
                      {rollbackPreview && (
                        <div className="ag-notice" role="status">
                          <strong>Rollback preview at pinned revision</strong>{' '}
                          <code>{rollbackPreview.baseRevision}</code>
                          <p>
                            Frontend: {rollbackPreview.before.frontendReplicas}{' '}
                            → {rollbackPreview.after.frontendReplicas}; backend:{' '}
                            {rollbackPreview.before.backendReplicas} →{' '}
                            {rollbackPreview.after.backendReplicas}.
                          </p>
                          <p>
                            Frontend image:{' '}
                            <code>{rollbackPreview.before.frontendImage}</code>{' '}
                            → <code>{rollbackPreview.after.frontendImage}</code>
                          </p>
                          <p>
                            Backend image:{' '}
                            <code>{rollbackPreview.before.backendImage}</code> →{' '}
                            <code>{rollbackPreview.after.backendImage}</code>
                          </p>
                          <p>
                            Changed files:{' '}
                            {rollbackPreview.changedFiles
                              .map(file => file.path)
                              .join(', ')}
                            . Protected routing and secret references remain
                            unchanged.
                          </p>
                          <small>
                            This preview creates no proposal or PR. Submission
                            repeats every eligibility and base check.
                          </small>
                        </div>
                      )}
                    </section>
                  )}
                </section>
              )}
              <div className="ag-workspace ag-cloud-workspace">
                <aside
                  id="review-queue"
                  className="ag-card ag-queue"
                  aria-labelledby="rizz-queue-title"
                >
                  <div className="ag-queue__top">
                    <span className="ag-eyebrow">Your workspace</span>
                    <h2 id="rizz-queue-title">Cloud review queue</h2>
                    <p>Review eligible changes or inspect delivery evidence.</p>
                  </div>
                  <div
                    className="ag-filter"
                    role="group"
                    aria-label="Cloud proposal filter"
                  >
                    <button
                      type="button"
                      className={
                        queueFilter === 'all' ? 'ag-filter__active' : ''
                      }
                      aria-pressed={queueFilter === 'all'}
                      onClick={() => setQueueFilter('all')}
                    >
                      All visible <span>{queue.length}</span>
                    </button>
                    <button
                      type="button"
                      className={
                        queueFilter === 'review' ? 'ag-filter__active' : ''
                      }
                      aria-pressed={queueFilter === 'review'}
                      onClick={() => setQueueFilter('review')}
                    >
                      Can review <span>{reviewCount}</span>
                    </button>
                  </div>
                  <label className="ag-search">
                    <span className="ag-visually-hidden">
                      Search cloud proposals
                    </span>
                    <input
                      type="search"
                      placeholder="Search operation, requester, ID"
                      value={queueQuery}
                      onChange={event => setQueueQuery(event.target.value)}
                    />
                  </label>
                  <div className="ag-queue__list">
                    {!visibleQueue.length && (
                      <div className="ag-empty">
                        {queue.length
                          ? 'No proposals match this view.'
                          : 'No cloud requests visible to your account.'}
                      </div>
                    )}
                    {visibleQueue.map(proposal => (
                      <button
                        className={`ag-queue-item ${
                          selected?.id === proposal.id
                            ? 'ag-queue-item--selected'
                            : ''
                        }`}
                        type="button"
                        disabled={busy || requiresRefresh}
                        key={proposal.id}
                        aria-pressed={selected?.id === proposal.id}
                        onClick={() => {
                          selectedId.current = proposal.id;
                          setSelected(proposal);
                          setReviewConfirmed(false);
                          setError('');
                        }}
                      >
                        <span className="ag-queue-item__top">
                          <strong>{proposalLabel(proposal)}</strong>
                          <span
                            className={`ag-status-dot ag-status-dot--${statusTone(
                              proposal.status,
                            )}`}
                            aria-hidden="true"
                          />
                        </span>
                        <span className="ag-queue-item__meta">
                          {proposal.requester}
                        </span>
                        <span className="ag-queue-item__bottom">
                          <span>{humanize(proposal.status)}</span>
                          <small>{proposal.id.slice(0, 8)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {selected && capability.canSubmit && (
                    <div className="ag-cloud-queue__footer">
                      <button
                        className="ag-button"
                        type="button"
                        onClick={startNewRequest}
                      >
                        Start another request
                      </button>
                    </div>
                  )}
                </aside>
                {selected && envelope ? (
                  <div
                    className="ag-detail"
                    role="region"
                    aria-label="Cloud proposal details"
                  >
                    <div className="ag-card ag-detail__header">
                      <div>
                        <span className="ag-eyebrow">
                          Proposal {selected.id}
                        </span>
                        <h2>{proposalLabel(selected)}</h2>
                        <p>
                          {envelope.target.clusterName} ·{' '}
                          {envelope.target.namespace}
                        </p>
                        <div className="ag-detail__meta">
                          <span>{envelope.target.region}</span>
                          <span>{envelope.target.owner}</span>
                          <span>{humanize(envelope.kind)}</span>
                        </div>
                      </div>
                      <span
                        className={`ag-pill ag-pill--${statusTone(
                          selected.status,
                        )}`}
                      >
                        {humanize(selected.status)}
                      </span>
                    </div>
                    <div className="ag-review-layout">
                      <div className="ag-review-layout__main">
                        <section className="ag-card">
                          <div className="ag-section-heading">
                            <div>
                              <span className="ag-eyebrow">
                                Review the request
                              </span>
                              <h3>Intent and proposed change</h3>
                            </div>
                          </div>
                          <div className="ag-compare">
                            <div>
                              <span className="ag-compare__label">
                                Declared intent
                              </span>
                              <p>{envelope.declaredIntent}</p>
                              <small id="rizz-intent-help">
                                {envelope.intentSource === 'agent_supplied'
                                  ? 'Agent-supplied declared intent, not verified original user words.'
                                  : 'Authenticated user-submitted statement, not cryptographic proof of original words.'}{' '}
                                Channel: {envelope.submissionChannel}
                              </small>
                            </div>
                            <div>
                              <span className="ag-compare__label">
                                Proposed execution
                              </span>
                              <dl className="ag-facts">
                                <div>
                                  <dt>Target</dt>
                                  <dd>
                                    {envelope.target.clusterName} ·{' '}
                                    {envelope.target.region} ·{' '}
                                    {envelope.target.namespace}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Owner</dt>
                                  <dd>{envelope.target.owner}</dd>
                                </div>
                                <div>
                                  <dt>Account</dt>
                                  <dd>{envelope.target.accountId}</dd>
                                </div>
                                <div>
                                  <dt>
                                    {envelope.template ? 'Recipe' : 'Operation'}
                                  </dt>
                                  <dd>
                                    {envelope.template
                                      ? `${envelope.template.id} · ${envelope.template.version}`
                                      : 'Staged application retirement'}
                                  </dd>
                                </div>
                                {!isRetirement(envelope.kind) && (
                                  <div>
                                    <dt>Replicas</dt>
                                    <dd>
                                      Frontend{' '}
                                      {envelope.kind ===
                                      'rizz_cloud_runtime_change'
                                        ? envelope.after?.frontendReplicas
                                        : envelope.inputs
                                            ?.frontendReplicas}{' '}
                                      · Backend{' '}
                                      {envelope.kind ===
                                      'rizz_cloud_runtime_change'
                                        ? envelope.after?.backendReplicas
                                        : envelope.inputs?.backendReplicas}
                                    </dd>
                                  </div>
                                )}
                              </dl>
                            </div>
                          </div>
                          <div className="ag-provenance">
                            <span>Requester: {selected.requester}</span>
                            <span>
                              Submission: {humanize(envelope.submissionChannel)}
                            </span>
                          </div>
                          <p>
                            Current desired state:{' '}
                            {selected.currentState.state === 'absent'
                              ? 'No application files at the reviewed base.'
                              : selected.currentState.state === 'retiring'
                              ? 'Ingress removed from desired state; other application files remain.'
                              : selected.currentState.state === 'retired'
                              ? 'Empty application marker remains; verify live cleanup separately.'
                              : `Frontend ${selected.currentState.frontendReplicas}, backend ${selected.currentState.backendReplicas} replicas; model ${selected.currentState.geminiModel}.`}
                          </p>
                          {selected.currentState.state === 'present' && (
                            <details className="ag-disclosure">
                              <summary>Current image pair</summary>
                              <pre>
                                {selected.currentState.frontendImage}
                                {'\n'}
                                {selected.currentState.backendImage}
                              </pre>
                            </details>
                          )}
                          {envelope.kind === 'rizz_cloud_runtime_change' && (
                            <div className="ag-notice" role="status">
                              <strong>Runtime-only change</strong>
                              <p>
                                Frontend replicas:{' '}
                                {envelope.before?.frontendReplicas} →{' '}
                                {envelope.after?.frontendReplicas}; backend
                                replicas: {envelope.before?.backendReplicas} →{' '}
                                {envelope.after?.backendReplicas}.
                              </p>
                              <p>
                                Changed: {envelope.changedFields?.join(', ')}.
                                Both image digests, Gemini model, networking and
                                unrequested manifests are preserved.
                              </p>
                            </div>
                          )}
                          {envelope.kind === 'rizz_cloud_rollback' &&
                            envelope.rollbackSource && (
                              <div className="ag-notice" role="status">
                                Restores verified deployment{' '}
                                <code>
                                  {envelope.rollbackSource.verifiedDeploymentId}
                                </code>{' '}
                                observed at {envelope.rollbackSource.verifiedAt}
                                . The selected evidence digest is{' '}
                                <code>
                                  {envelope.rollbackSource.snapshotDigest}
                                </code>
                                .
                              </div>
                            )}
                          {isRetirement(envelope.kind) && (
                            <div
                              className="ag-notice ag-notice--warning"
                              role="status"
                            >
                              <strong>
                                {envelope.kind === 'rizz_cloud_retire_ingress'
                                  ? 'Stage 1: remove ingress'
                                  : 'Stage 2: remove app resources'}
                              </strong>
                              <p>Reason: {envelope.reason}</p>
                              {envelope.cleanupEvidence && (
                                <p>
                                  Private observer found ingress, ALB and target
                                  groups absent at{' '}
                                  {envelope.cleanupEvidence.checkedAt}.
                                </p>
                              )}
                              <p>
                                Foundation, release images, runtime secret and
                                audit records remain. Only a distinct platform
                                reviewer can approve.
                              </p>
                            </div>
                          )}
                          {envelope.kind !== 'rizz_cloud_runtime_change' &&
                            envelope.release && (
                              <>
                                <p>
                                  Proposed commit:{' '}
                                  <code>
                                    {envelope.release.record.source.commit}
                                  </code>
                                </p>
                                {(['frontend', 'backend'] as const).map(
                                  part => (
                                    <p key={part}>
                                      {part} image:{' '}
                                      <code>
                                        {
                                          envelope.release!.record.images[part]
                                            .repository
                                        }
                                        @
                                        {
                                          envelope.release!.record.images[part]
                                            .digest
                                        }
                                      </code>
                                    </p>
                                  ),
                                )}
                                <p>
                                  Release record:{' '}
                                  <code>{envelope.release.recordDigest}</code> ·
                                  Available until:{' '}
                                  {envelope.release.record.expiresAt}
                                </p>
                              </>
                            )}
                          {!isRetirement(envelope.kind) && (
                            <div className="ag-notice ag-notice--warning">
                              Restricted public frontend, not internal-only:{' '}
                              {envelope.target.ingress.hostname} · HTTPS/443 ·
                              source {envelope.target.ingress.operatorCidr}.
                              Self-signed TLS; trust the reviewed certificate.
                              Backend remains private.
                            </div>
                          )}
                          <details className="ag-disclosure">
                            <summary>
                              Certificate and GitOps destination
                            </summary>
                            <p>
                              Certificate ARN:{' '}
                              {envelope.target.ingress.certificateArn}
                            </p>
                            <p>
                              Certificate fingerprint:{' '}
                              <code>
                                {envelope.target.ingress.certificateSha256}
                              </code>
                            </p>
                            <p>
                              {envelope.target.gitopsRepository} ·{' '}
                              {envelope.target.gitopsBranch}/
                              {envelope.target.gitopsPath}
                            </p>
                            <p>
                              Argo Application:{' '}
                              {envelope.target.argoApplication}
                            </p>
                          </details>
                        </section>
                        <JevPanel semantic={selected.semantic} />
                        <section
                          className="ag-card"
                          aria-labelledby="rizz-files-title"
                        >
                          <div className="ag-section-heading">
                            <div>
                              <span className="ag-eyebrow">
                                Frozen execution snapshot
                              </span>
                              <h2 id="rizz-files-title">Exact GitOps change</h2>
                            </div>
                            <span className="ag-pill ag-pill--neutral">
                              {selected.snapshot.files.length} files
                            </span>
                          </div>
                          <p className="ag-muted">
                            Review the proposed files below. They are based on
                            GitOps revision{' '}
                            <code>
                              {envelope.gitopsBase.revision.slice(0, 12)}
                            </code>
                            , not a live cluster diff. A changed base needs
                            fresh review.
                          </p>
                          {selected.snapshot.deletePaths?.length ? (
                            <div className="ag-notice ag-notice--warning">
                              <strong>Exact paths to delete</strong>
                              <ul>
                                {selected.snapshot.deletePaths.map(path => (
                                  <li key={path}>
                                    <code>{path}</code>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          <div className="ag-files">
                            {selected.snapshot.files.map(file => (
                              <ManifestFilePreview
                                key={file.path}
                                file={file}
                              />
                            ))}
                          </div>
                          <details className="ag-disclosure">
                            <summary>
                              Approval metadata and reviewed base hashes
                            </summary>
                            <div className="ag-disclosure__body">
                              <p>
                                Approval digest:{' '}
                                <code>{selected.snapshot.digest}</code>
                              </p>
                              <p>
                                Full GitOps base:{' '}
                                <code>{envelope.gitopsBase.revision}</code>
                              </p>
                              <p>Policy: {envelope.policyVersion}</p>
                              <p>
                                Eligible reviewer groups:{' '}
                                {(
                                  envelope.reviewerGroups ?? [
                                    envelope.target.owner,
                                  ]
                                ).join(' or ')}
                              </p>
                              {envelope.template && (
                                <p>
                                  Recipe digest:{' '}
                                  <code>{envelope.template.digest}</code>
                                </p>
                              )}
                              <details className="ag-disclosure">
                                <summary>
                                  Existing file hashes at the reviewed base
                                </summary>
                                <pre>
                                  {JSON.stringify(
                                    envelope.gitopsBase.files,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </details>
                            </div>
                          </details>
                        </section>
                      </div>
                      <aside
                        className="ag-card ag-review-panel"
                        aria-labelledby="rizz-review-heading"
                      >
                        <span className="ag-eyebrow">Decision gate</span>
                        <h3 id="rizz-review-heading">Human review</h3>
                        <span
                          className={`ag-pill ag-pill--${
                            selected.viewerPermissions.canReview
                              ? 'positive'
                              : 'neutral'
                          }`}
                        >
                          {selected.viewerPermissions.canReview
                            ? 'Eligible reviewer'
                            : 'Read only'}
                        </span>
                        <p>
                          A distinct authenticated member of an eligible
                          reviewer group must review the exact snapshot. Jev
                          cannot authorize execution.
                        </p>
                        <div className="ag-policy">
                          <span>Deterministic policy</span>
                          <strong>
                            {isRetirement(envelope.kind)
                              ? 'Platform review'
                              : 'Application or platform review'}
                          </strong>
                          <ul>
                            {selected.reasonCodes.map(reason => (
                              <li key={reason}>{humanize(reason)}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="ag-digest">
                          <span>Approval digest</span>
                          <code>{selected.snapshot.digest}</code>
                        </div>
                        {selected.viewerPermissions.canReview ? (
                          <div className="ag-review-actions">
                            <label className="ag-confirm">
                              <input
                                type="checkbox"
                                checked={reviewConfirmed}
                                disabled={busy || requiresRefresh}
                                onChange={event =>
                                  setReviewConfirmed(event.target.checked)
                                }
                              />{' '}
                              <span>
                                I reviewed the{' '}
                                {reviewDescription(envelope.kind)}, exact
                                manifests and base revision.
                              </span>
                            </label>
                            <button
                              className="ag-button ag-button--primary"
                              disabled={
                                busy || requiresRefresh || !reviewConfirmed
                              }
                              onClick={() => decide('approve')}
                            >
                              Approve exact cloud snapshot
                            </button>
                            <button
                              className="ag-button ag-button--danger"
                              disabled={busy || requiresRefresh}
                              onClick={() => decide('reject')}
                            >
                              Reject cloud proposal
                            </button>
                          </div>
                        ) : (
                          <p>
                            Read only: this account cannot approve this request
                            in its current state.
                          </p>
                        )}
                        {selected.decision && (
                          <div className="ag-decision-record">
                            <strong>
                              {humanize(selected.decision.decision)}
                            </strong>
                            <p>
                              by {selected.decision.reviewer} at{' '}
                              {selected.decision.at}
                            </p>
                            <small>
                              Against <code>{selected.decision.digest}</code>
                            </small>
                          </div>
                        )}
                      </aside>
                    </div>
                    <section className="ag-card">
                      <span className="ag-eyebrow">
                        Scaffolder handoff only
                      </span>
                      <h2>Delivery handoff</h2>
                      <p>
                        Status:{' '}
                        {humanize(selected.execution?.state ?? 'not_started')}
                        {selected.execution?.errorCode
                          ? ` · ${humanize(selected.execution.errorCode)}`
                          : ''}
                      </p>
                      {selected.execution?.taskId && (
                        <p>
                          Private task: {selected.execution.taskId} (logs
                          restricted to the backend service)
                        </p>
                      )}
                      {selected.execution?.prUrl && (
                        <p>
                          <a
                            href={selected.execution.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open draft GitOps PR
                          </a>
                        </p>
                      )}
                      <details className="ag-disclosure">
                        <summary>Audit trail</summary>
                        <pre>{JSON.stringify(selected.audit, null, 2)}</pre>
                      </details>
                    </section>
                    {!isRetirement(envelope.kind) && (
                      <CloudDeliveryPanel
                        key={selected.id}
                        proposalId={selected.id}
                      />
                    )}
                    {isRetirement(envelope.kind) && (
                      <CloudRetirementPanel
                        key={selected.id}
                        proposalId={selected.id}
                      />
                    )}
                  </div>
                ) : (
                  <div className="ag-card ag-empty-detail">
                    <h2>Choose a cloud proposal</h2>
                    <p>
                      Select a request from the queue to review its frozen
                      change and delivery evidence.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Container>
    </>
  );
}
