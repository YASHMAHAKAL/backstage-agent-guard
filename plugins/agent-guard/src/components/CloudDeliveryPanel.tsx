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
export function CloudDeliveryPanel({ proposalId }: { proposalId: string }) {
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
  return (
    <section className="ag-card" aria-label="Read-only cloud observation">
      <span className="ag-eyebrow">Read-only cloud observation</span>
      <h2>Cloud delivery journey</h2>
      <p>
        Checking reads GitHub, dedicated EKS Argo CD, live workloads and ALB
        readiness. It never merges, syncs, deploys or calls Gemini.
      </p>
      <button className="ag-button" disabled={busy} onClick={check}>
        {busy ? 'Checking cloud delivery…' : 'Check cloud delivery'}
      </button>
      {error && <p role="alert">{error}</p>}
      <progress
        aria-label="Verified delivery evidence"
        max={4}
        value={completed}
      />
      <p>{completed} of 4 evidence stages verified</p>
      <div className="ag-cloud-delivery-grid">
        <div>
          <h3>GitHub merge</h3>
          <p>{humanize(observation?.github.state ?? 'not_checked')}</p>
          {observation?.github.revision && (
            <code>{observation.github.revision}</code>
          )}
        </div>
        <div>
          <h3>Argo CD</h3>
          <p>{humanize(observation?.argoCd.state ?? 'not_checked')}</p>
          {observation?.argoCd.sync && (
            <p>
              Sync: {observation.argoCd.sync} · Health:{' '}
              {observation.argoCd.health}
            </p>
          )}
          {observation?.argoCd.revision && (
            <code>{observation.argoCd.revision}</code>
          )}
        </div>
        <div>
          <h3>Kubernetes rollout</h3>
          <p>{humanize(observation?.workloads.state ?? 'not_checked')}</p>
          {observation?.workloads.reason && (
            <p>{humanize(observation.workloads.reason)}</p>
          )}
          {(['frontend', 'backend'] as const).map(part => {
            const rollout = observation?.workloads[part];
            return rollout ? (
              <p key={part}>
                {part}: {rollout.readyPods}/{rollout.desired} Pods ready ·{' '}
                {rollout.updated} updated · {rollout.available} available ·
                generation {rollout.generation}
              </p>
            ) : null;
          })}
        </div>
        <div>
          <h3>HTTPS smoke test</h3>
          <p>{humanize(observation?.smoke.state ?? 'not_checked')}</p>
          {observation?.smoke.reason && (
            <p>{humanize(observation.smoke.reason)}</p>
          )}
          {observation?.smoke.state === 'verified' && (
            <p>
              /healthz: alive · /readyz: ready · reviewed TLS certificate
              verified
            </p>
          )}
        </div>
      </div>
      <div className="ag-notice" role="status">
        {observation?.deployed
          ? 'Deployment verified for the approved release at this observation.'
          : 'Deployment not verified. All four evidence stages must pass; Argo Healthy alone is insufficient.'}
      </div>
      {observation && (
        <p>
          Observed at {observation.checkedAt}. This is a point-in-time read, not
          continuous monitoring.
        </p>
      )}
    </section>
  );
}
