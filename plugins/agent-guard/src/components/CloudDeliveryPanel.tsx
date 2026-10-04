import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { useEffect, useRef, useState } from 'react';
import { humanize } from './ProposalsPage/model';

type Observation = {
  checkedAt: string;
  github: { state: string; revision?: string };
  argoCd: { state: string; revision?: string; sync?: string; health?: string };
  workloads: {
    state: string;
    reason?: string;
    frontend?: Rollout;
    backend?: Rollout;
  };
  smoke: {
    state: string;
    reason?: string;
    health?: string;
    readiness?: string;
  };
  deployed: boolean;
};
type Rollout = {
  desired: number;
  updated: number;
  available: number;
  readyPods: number;
  generation: number;
};
type ProposalHandoff = {
  status: string;
  decision?: { decision: string };
  execution?: {
    state: string;
    taskId?: string;
    prUrl?: string;
    errorCode?: string;
  };
};
const states = [
  'not_configured',
  'not_checked',
  'verified',
  'not_ready',
  'mismatch',
  'unavailable',
];
const validRollout = (value: Rollout) =>
  value &&
  [1, 2].includes(value.desired) &&
  value.updated === value.desired &&
  value.available === value.desired &&
  value.readyPods === value.desired &&
  Number.isSafeInteger(value.generation) &&
  value.generation > 0;
export function CloudDeliveryPanel({
  proposalId,
  handoff,
}: {
  proposalId: string;
  handoff: ProposalHandoff;
}) {
  const { fetch } = useApi(fetchApiRef);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function check() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), 50000);
    setObservation(null); // Never retain stale green evidence during a refresh.
    setError('');
    setBusy(true);
    try {
      const response = await fetch(
        `plugin://agent-guard/rizz/proposals/${encodeURIComponent(
          proposalId,
        )}/delivery`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (
        typeof data.deployed !== 'boolean' ||
        !Number.isFinite(Date.parse(data.checkedAt)) ||
        typeof data.github?.state !== 'string' ||
        typeof data.argoCd?.state !== 'string' ||
        !states.includes(data.workloads?.state) ||
        !states.includes(data.smoke?.state) ||
        (data.workloads.state === 'verified' &&
          (!validRollout(data.workloads.frontend) ||
            !validRollout(data.workloads.backend))) ||
        (data.smoke.state === 'verified' &&
          (data.smoke.health !== 'alive' ||
            data.smoke.readiness !== 'ready')) ||
        (data.deployed &&
          (data.github.state !== 'merged_files_match' ||
            data.argoCd.state !== 'synced_files_match' ||
            data.argoCd.sync !== 'Synced' ||
            data.argoCd.health !== 'Healthy' ||
            data.workloads.state !== 'verified' ||
            data.smoke.state !== 'verified'))
      )
        throw new Error('Unsupported evidence');
      setObservation(data);
    } catch {
      // Abort includes timeout; don't leave the panel claiming a successful read.
      setError(
        'Cloud observation unavailable. No cached result is treated as current.',
      );
    } finally {
      clearTimeout(timer);
      request.current = null;
      setBusy(false);
    }
  }
  const completed = observation
    ? [
        observation.github.state === 'merged_files_match',
        observation.argoCd.state === 'synced_files_match',
        observation.workloads.state === 'verified',
        observation.smoke.state === 'verified',
      ].filter(Boolean).length
    : 0;
  const stages = [
    { label: 'Proposed', done: true },
    { label: 'Approved', done: handoff.decision?.decision === 'approve' },
    { label: 'Task started', done: Boolean(handoff.execution?.taskId) },
    { label: 'PR opened', done: Boolean(handoff.execution?.prUrl) },
    {
      label: 'Merge verified',
      done: observation?.github.state === 'merged_files_match',
    },
    {
      label: 'Argo synced',
      done:
        observation?.argoCd.state === 'synced_files_match' &&
        observation.argoCd.sync === 'Synced',
    },
    { label: 'Verified', done: observation?.deployed === true },
  ];
  const currentIndex = stages.findIndex(stage => !stage.done);
  const halted = [
    'rejected',
    'needs_clarification',
    'execution_failed',
    'publish_failed',
  ].includes(handoff.status);
  return (
    <section
      className="ag-card ag-delivery ag-cloud-delivery"
      aria-label="Read-only cloud observation"
    >
      <div className="ag-section-heading">
        <div>
          <span className="ag-eyebrow">Read-only observation</span>
          <h3>Cloud delivery journey</h3>
        </div>
        <button
          className="ag-button"
          type="button"
          disabled={busy}
          onClick={check}
        >
          {busy ? 'Checking cloud delivery…' : 'Check cloud delivery'}
        </button>
      </div>
      <p className="ag-muted">
        Approval starts Scaffolder; a human merges the PR before Argo CD can
        deploy. This check only reads GitHub, Argo CD, Kubernetes and HTTPS
        evidence.
      </p>
      {error && <p role="alert">{error}</p>}
      <ol className="ag-track" aria-label="Cloud delivery stages">
        {stages.map((stage, index) => {
          const state = stage.done
            ? 'done'
            : index !== currentIndex
            ? 'future'
            : halted
            ? 'halted'
            : 'current';
          return (
            <li
              key={stage.label}
              className={`ag-track__stage ag-track__stage--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="ag-track__bar" aria-hidden="true" />
              <strong>{stage.label}</strong>
              <small>
                {state === 'done'
                  ? 'Complete'
                  : state === 'halted'
                  ? 'On hold'
                  : state === 'current'
                  ? 'Awaiting'
                  : 'Not reached'}
              </small>
            </li>
          );
        })}
      </ol>
      <div className="ag-cloud-delivery__evidence-heading">
        <strong>Evidence</strong>
        <span className="ag-pill ag-pill--neutral">
          {completed} of 4 checks verified
        </span>
      </div>
      <div className="ag-delivery__facts">
        <div>
          <span>Scaffolder handoff</span>
          <strong>{humanize(handoff.execution?.state ?? 'not_started')}</strong>
          {handoff.execution?.taskId && (
            <small>
              Task <code>{handoff.execution.taskId}</code> · logs restricted to
              the backend service
            </small>
          )}
          {handoff.execution?.errorCode && (
            <small>{humanize(handoff.execution.errorCode)}</small>
          )}
        </div>
        <div>
          <span>GitHub pull request</span>
          <strong>
            {humanize(observation?.github.state ?? 'not_checked')}
          </strong>
          {handoff.execution?.prUrl && (
            <a
              href={handoff.execution.prUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open GitOps PR
            </a>
          )}
          {observation?.github.revision && (
            <small>
              Revision <code>{observation.github.revision}</code>
            </small>
          )}
        </div>
        <div>
          <span>Argo CD</span>
          <strong>
            {humanize(observation?.argoCd.state ?? 'not_checked')}
          </strong>
          {observation?.argoCd.sync && (
            <small>
              Sync: {observation.argoCd.sync} · Health:{' '}
              {observation.argoCd.health}
            </small>
          )}
          {observation?.argoCd.revision && (
            <small>
              Revision <code>{observation.argoCd.revision}</code>
            </small>
          )}
        </div>
        <div>
          <span>Kubernetes rollout</span>
          <strong>
            {humanize(observation?.workloads.state ?? 'not_checked')}
          </strong>
          {observation?.workloads.reason && (
            <small>{humanize(observation.workloads.reason)}</small>
          )}
          {(['frontend', 'backend'] as const).map(part => {
            const rollout = observation?.workloads[part];
            return rollout ? (
              <small key={part}>
                {part}: {rollout.readyPods}/{rollout.desired} Pods ready ·{' '}
                {rollout.updated} updated · {rollout.available} available ·
                generation {rollout.generation}
              </small>
            ) : null;
          })}
        </div>
        <div>
          <span>HTTPS smoke test</span>
          <strong>{humanize(observation?.smoke.state ?? 'not_checked')}</strong>
          {observation?.smoke.reason && (
            <small>{humanize(observation.smoke.reason)}</small>
          )}
          {observation?.smoke.state === 'verified' && (
            <small>
              /healthz: alive · /readyz: ready · reviewed TLS certificate
              verified
            </small>
          )}
        </div>
      </div>
      <div
        className={`ag-delivery__verdict ${
          observation?.deployed ? 'ag-delivery__verdict--verified' : ''
        }`}
        role="status"
      >
        <span aria-hidden="true">{observation?.deployed ? '✓' : '○'}</span>
        <strong>
          {observation?.deployed
            ? 'Deployment verified for the approved release at this observation.'
            : 'Deployment not verified. All four evidence stages must pass; Argo Healthy alone is insufficient.'}
        </strong>
        {observation && (
          <small>
            Observed at {new Date(observation.checkedAt).toLocaleString()}
          </small>
        )}
      </div>
      <p className="ag-cloud-delivery__footnote">
        A check is a point-in-time observation, not continuous monitoring.
      </p>
    </section>
  );
}
