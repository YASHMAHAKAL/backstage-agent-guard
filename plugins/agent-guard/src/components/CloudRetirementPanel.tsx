import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { useEffect, useState } from 'react';

type Observation = {
  stage: 'rizz_cloud_retire_ingress' | 'rizz_cloud_retire_app';
  state:
    | 'waiting_for_pr'
    | 'waiting_for_merge'
    | 'waiting_for_gitops'
    | 'cleanup_not_verified'
    | 'complete'
    | 'unavailable';
  complete: boolean;
  checkedAt: string;
  prUrl?: string;
  mainRevision?: string;
};
const descriptions: Record<Observation['state'], string> = {
  waiting_for_pr: 'The approved draft PR has not been recorded yet.',
  waiting_for_merge: 'The draft PR still needs a human merge.',
  waiting_for_gitops:
    'The merged change is not yet the exact current GitOps state.',
  cleanup_not_verified:
    'Live resource cleanup has not been verified. Check Argo prune and the remaining Kubernetes or AWS resources.',
  complete:
    'The exact merged change and live cleanup were verified at this check.',
  unavailable: 'Retirement evidence could not be verified right now.',
};

export function CloudRetirementPanel({ proposalId }: { proposalId: string }) {
  const { fetch } = useApi(fetchApiRef);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setObservation(null);
    void fetch(`plugin://agent-guard/rizz/proposals/${proposalId}/retirement`, {
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error('Read unavailable');
        return response.json();
      })
      .then(value => {
        if (!controller.signal.aborted) setObservation(value as Observation);
      })
      .catch(() => {
        if (!controller.signal.aborted) setObservation(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetch, proposalId, refresh]);
  return (
    <section className="ag-card">
      <div className="ag-section-heading">
        <div>
          <span className="ag-eyebrow">Read-only observation</span>
          <h2>Retirement progress</h2>
        </div>
        <button
          className="ag-button"
          type="button"
          disabled={loading}
          onClick={() => setRefresh(value => value + 1)}
        >
          Check again
        </button>
      </div>
      {loading && <p role="status">Checking PR, GitOps and live resources…</p>}
      {!loading && !observation && (
        <p role="status">Retirement observation is unavailable.</p>
      )}
      {observation && (
        <div role="status">
          <p>
            {observation.stage === 'rizz_cloud_retire_ingress'
              ? 'Ingress stage'
              : 'Application cleanup stage'}{' '}
            · {descriptions[observation.state]}
          </p>
          <small>Checked {observation.checkedAt}</small>
          {observation.mainRevision && (
            <p>
              Current GitOps revision: <code>{observation.mainRevision}</code>
            </p>
          )}
          {observation.prUrl && (
            <p>
              <a href={observation.prUrl}>Reviewed GitOps PR</a>
            </p>
          )}
          {observation.stage === 'rizz_cloud_retire_app' &&
            observation.complete && (
              <p>
                Application resources are absent. The empty Argo application
                marker, namespace, EKS, registry, runtime secret and audit
                records are retained for separate platform decisions.
              </p>
            )}
        </div>
      )}
      <p className="ag-muted">
        Checking status never syncs or deletes resources.
      </p>
    </section>
  );
}
