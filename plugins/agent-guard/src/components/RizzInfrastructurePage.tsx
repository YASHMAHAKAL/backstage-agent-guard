import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import './ProposalsPage/ProposalsPage.css';
import './RizzInfrastructurePage.css';

type Capability = {
  state: 'disabled' | 'request_and_review';
  executable: false;
};
type Plan = {
  bindingDigest: string;
  binding: {
    root: 'registry' | 'staging';
    accountId: string;
    region: string;
    sourceCommit: string;
    runnerId: string;
    planDigest: string;
    expiresAt: string;
    stateLineage: string | null;
    stateSerial: number | null;
  };
  summary: {
    counts: Record<'create' | 'update' | 'delete' | 'replace' | 'read', number>;
    changes: Array<{
      address: string;
      type: string;
      action: string;
      workerDesiredSize?: { before: number | null; after: number | null };
    }>;
  };
  configurationPr: { url: string; mergedCommit: string };
  registeredAt: string;
};
type Request = {
  id: string;
  status:
    | 'awaiting_configuration_pr'
    | 'awaiting_plan_review'
    | 'plan_approved'
    | 'plan_rejected'
    | 'runner_reported_applied'
    | 'runner_unknown';
  requester: string;
  createdAt: string;
  request: {
    operation: 'foundation_setup';
    root: 'registry' | 'staging';
    declaredIntent: string;
  };
  plan?: Plan;
  decision?: {
    decision: 'approve' | 'reject';
    reviewer: string;
    at: string;
    comment?: string;
  };
  runnerOutcome?: {
    runId: string;
    status: 'applied' | 'unknown';
    reportedAt: string;
  };
  canReview: boolean;
  executable: false;
};

export function RizzInfrastructurePage() {
  const { fetch } = useApi(fetchApiRef);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [root, setRoot] = useState<'registry' | 'staging'>('staging');
  const [intent, setIntent] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const selected = requests.find(item => item.id === selectedId);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const caps = await fetch(
        'plugin://agent-guard/rizz/terraform/capabilities',
      );
      if (caps.status === 403) {
        setAccessDenied(true);
        return;
      }
      if (!caps.ok) throw new Error('Infrastructure controls are unavailable');
      const next = (await caps.json()) as Capability;
      setCapability(next);
      if (next.state === 'disabled') {
        setRequests([]);
        return;
      }
      const response = await fetch(
        'plugin://agent-guard/rizz/terraform/requests',
      );
      if (!response.ok)
        throw new Error('Could not load infrastructure requests');
      const listing = (await response.json()) as { items: Request[] };
      setRequests(listing.items);
      setSelectedId(current =>
        listing.items.some(item => item.id === current)
          ? current
          : listing.items[0]?.id ?? '',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        'plugin://agent-guard/rizz/terraform/requests',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'foundation_setup',
            root,
            declaredIntent: intent,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Request was not recorded (${response.status})`);
      const created = (await response.json()) as Request;
      setIntent('');
      await refresh();
      setSelectedId(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'reject') {
    if (!selected?.plan || !selected.canReview || !acknowledged) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `plugin://agent-guard/rizz/terraform/requests/${selected.id}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            bindingDigest: selected.plan.bindingDigest,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Decision was not recorded (${response.status})`);
      setAcknowledged(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ag-page ag-infra-page">
      <section className="ag-hero ag-infra-hero">
        <p className="ag-kicker">RIZZ.AI · PLATFORM WORKSPACE</p>
        <h1>Infrastructure review</h1>
        <p>
          Terraform configuration, the executable saved plan, and application
          GitOps delivery are separate decisions. This page never runs
          Terraform.
        </p>
      </section>

      {loading && <p role="status">Loading infrastructure controls…</p>}
      {accessDenied && (
        <section className="ag-infra-card" role="alert">
          Platform-team membership is required to see infrastructure requests
          and plans. Application users can use the Rizz.AI Control Center for
          environment readiness.
        </section>
      )}
      {error && (
        <p className="ag-infra-error" role="alert">
          {error}
        </p>
      )}
      {!loading && capability?.state === 'disabled' && (
        <section className="ag-infra-card">
          <h2>Not configured</h2>
          <p>
            The reviewed configuration reader and runner keys are not connected.
            No plan review or apply controls are available.
          </p>
        </section>
      )}

      {!loading &&
        !accessDenied &&
        capability?.state === 'request_and_review' && (
          <div className="ag-infra-grid">
            <section className="ag-infra-card">
              <p className="ag-kicker">REQUEST</p>
              <h2>Record foundation intent</h2>
              <p>
                This records a platform request only. An operator must create
                and merge a separately reviewed configuration PR before a
                trusted runner can register an actual saved plan.
              </p>
              <form onSubmit={submit} className="ag-infra-form">
                <label htmlFor="infra-root">Terraform root</label>
                <select
                  id="infra-root"
                  value={root}
                  onChange={event =>
                    setRoot(event.target.value as 'registry' | 'staging')
                  }
                >
                  <option value="registry">Registry</option>
                  <option value="staging">EKS staging</option>
                </select>
                <label htmlFor="infra-intent">Declared intent</label>
                <textarea
                  id="infra-intent"
                  minLength={20}
                  maxLength={1000}
                  required
                  value={intent}
                  onChange={event => setIntent(event.target.value)}
                  placeholder="Set up the reviewed Rizz.AI staging foundation in us-east-1…"
                />
                <button disabled={busy} type="submit">
                  Record request
                </button>
              </form>
            </section>

            <section className="ag-infra-card">
              <p className="ag-kicker">REVIEW QUEUE</p>
              <h2>Infrastructure requests</h2>
              {requests.length === 0 ? (
                <p>No requests recorded yet.</p>
              ) : (
                <ul className="ag-infra-list">
                  {requests.map(item => (
                    <li key={item.id}>
                      <button
                        className={item.id === selectedId ? 'is-selected' : ''}
                        onClick={() => {
                          setSelectedId(item.id);
                          setAcknowledged(false);
                        }}
                        type="button"
                      >
                        <span>{item.request.root} foundation</span>
                        <small>{item.status.replaceAll('_', ' ')}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ag-infra-card ag-infra-detail">
              <p className="ag-kicker">EXACT CHANGE</p>
              <h2>
                {selected
                  ? `${selected.request.root} foundation`
                  : 'Select a request'}
              </h2>
              {selected && (
                <>
                  <p>
                    <strong>Requester:</strong> {selected.requester}
                  </p>
                  <p>
                    <strong>Declared intent:</strong>{' '}
                    {selected.request.declaredIntent}
                  </p>
                  <p>
                    <strong>Status:</strong>{' '}
                    {selected.status.replaceAll('_', ' ')}
                  </p>
                  {selected.plan ? (
                    <>
                      <p>
                        <strong>Reviewed config PR:</strong>{' '}
                        <a
                          href={selected.plan.configurationPr.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open merged PR
                        </a>
                      </p>
                      <p>
                        <strong>Source commit:</strong>{' '}
                        <code>{selected.plan.binding.sourceCommit}</code>
                      </p>
                      <p>
                        <strong>Target:</strong>{' '}
                        {selected.plan.binding.accountId} ·{' '}
                        {selected.plan.binding.region}
                      </p>
                      <p>
                        <strong>Runner:</strong>{' '}
                        {selected.plan.binding.runnerId}
                      </p>
                      <p>
                        <strong>State:</strong>{' '}
                        {selected.plan.binding.stateLineage ?? 'absent'} /{' '}
                        {selected.plan.binding.stateSerial ?? '—'}
                      </p>
                      <p>
                        <strong>Plan expires:</strong>{' '}
                        {selected.plan.binding.expiresAt}
                      </p>
                      <p>
                        <strong>Plan digest:</strong>{' '}
                        <code>{selected.plan.binding.planDigest}</code>
                      </p>
                      <p>
                        <strong>Approval digest:</strong>{' '}
                        <code>{selected.plan.bindingDigest}</code>
                      </p>
                      <div className="ag-infra-counts">
                        {Object.entries(selected.plan.summary.counts).map(
                          ([name, count]) => (
                            <span key={name}>
                              {name}: {count}
                            </span>
                          ),
                        )}
                      </div>
                      <ul className="ag-infra-changes">
                        {selected.plan.summary.changes.map(change => (
                          <li key={change.address}>
                            <strong>{change.action}</strong> {change.address}
                            {change.workerDesiredSize &&
                              ` (${change.workerDesiredSize.before ?? '—'} → ${
                                change.workerDesiredSize.after ?? '—'
                              } workers)`}
                          </li>
                        ))}
                      </ul>
                      {selected.canReview && (
                        <div className="ag-infra-decision">
                          <label>
                            <input
                              type="checkbox"
                              checked={acknowledged}
                              onChange={event =>
                                setAcknowledged(event.target.checked)
                              }
                            />
                            I reviewed this exact saved-plan summary and digest.
                          </label>
                          <div>
                            <button
                              disabled={busy || !acknowledged}
                              onClick={() => void decide('approve')}
                              type="button"
                            >
                              Approve plan
                            </button>
                            <button
                              disabled={busy || !acknowledged}
                              onClick={() => void decide('reject')}
                              type="button"
                            >
                              Reject plan
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <p>
                      No executable plan is registered. Configuration review is
                      not plan approval; this request cannot be applied.
                    </p>
                  )}
                  {selected.decision && (
                    <p>
                      <strong>Decision:</strong> {selected.decision.decision} by{' '}
                      {selected.decision.reviewer}
                    </p>
                  )}
                  {selected.runnerOutcome && (
                    <p role="status">
                      <strong>Runner report:</strong>{' '}
                      {selected.runnerOutcome.status === 'applied'
                        ? 'Terraform command reported success'
                        : 'Execution outcome is unknown'}{' '}
                      at {selected.runnerOutcome.reportedAt}. This is not
                      independent AWS readiness verification.
                    </p>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      <p className="ag-infra-footnote">
        Apply, destroy, drift remediation and AWS deployment are unavailable
        here. A separate protected runner and independent status observation
        must be connected first.
      </p>
    </div>
  );
}
