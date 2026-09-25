import { DeliveryStatus, humanize, Proposal } from './model';

type StageState = 'done' | 'halted' | 'current' | 'future';

const stageLabels: Record<StageState, string> = {
  done: 'Complete',
  halted: 'On hold',
  current: 'Awaiting',
  future: 'Not reached',
};

function stageState(
  done: boolean,
  index: number,
  currentIndex: number,
  halted: boolean,
): StageState {
  if (done) return 'done';
  if (index !== currentIndex) return 'future';
  return halted ? 'halted' : 'current';
}

export function DeliveryPanel({
  proposal,
  delivery,
  loading,
  error,
}: {
  proposal: Proposal;
  delivery: DeliveryStatus | null;
  loading: boolean;
  error: string | null;
}) {
  const mergeCommitSha =
    delivery?.github.state === 'merged' && delivery.github.approvedFilesMatch
      ? delivery.github.mergeCommitSha
      : undefined;
  const merged = Boolean(mergeCommitSha);
  const synced =
    merged &&
    delivery?.argoCd.state === 'observed' &&
    delivery.argoCd.syncStatus === 'Synced' &&
    delivery.argoCd.includesApprovedMerge;
  const stages = [
    { label: 'Proposed', done: true },
    { label: 'Approved', done: proposal.decision?.decision === 'approve' },
    { label: 'Task started', done: Boolean(proposal.execution?.taskId) },
    { label: 'PR opened', done: Boolean(proposal.execution?.prUrl) },
    { label: 'Merge verified', done: Boolean(merged) },
    { label: 'Argo synced', done: Boolean(synced) },
    { label: 'Verified', done: delivery?.deployed === true },
  ];
  const currentIndex = stages.findIndex(stage => !stage.done);
  const halted =
    proposal.status === 'rejected' ||
    proposal.status === 'needs_clarification' ||
    proposal.status === 'execution_failed' ||
    proposal.status === 'publish_failed';
  let verdict = 'Not verified as deployed';
  if (delivery?.deployed) {
    verdict =
      'Verified in a shared staging revision containing the approved merge';
  } else if (loading && !delivery) verdict = 'Checking deployment evidence…';

  return (
    <section
      className="ag-card ag-delivery"
      aria-labelledby="ag-delivery-heading"
    >
      <div className="ag-section-heading">
        <div>
          <span className="ag-eyebrow">Read-only observation</span>
          <h3 id="ag-delivery-heading">Delivery journey</h3>
        </div>
        <span className="ag-pill ag-pill--neutral">No deployment action</span>
      </div>
      <p className="ag-muted">
        Approval starts a Scaffolder task; a human PR merge is a separate
        release decision. Refreshing this panel never deploys.
      </p>
      <ol className="ag-track" aria-label="Delivery stages">
        {stages.map((stage, index) => {
          const state = stageState(stage.done, index, currentIndex, halted);
          return (
            <li
              key={stage.label}
              className={`ag-track__stage ag-track__stage--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="ag-track__bar" aria-hidden="true" />
              <strong>{stage.label}</strong>
              <small>{stageLabels[state]}</small>
            </li>
          );
        })}
      </ol>

      <div className="ag-delivery__facts">
        <div>
          <span>Scaffolder handoff</span>
          <strong>
            {humanize(proposal.execution?.state ?? 'not_started')}
          </strong>
          {proposal.execution?.taskId && (
            <small>
              Task <code>{proposal.execution.taskId}</code> (details restricted
              to the backend service)
            </small>
          )}
          {proposal.execution?.state === 'failed' && (
            <small>No automatic retry after ambiguous dispatch.</small>
          )}
        </div>
        <div>
          <span>GitHub pull request</span>
          <strong>
            {delivery ? humanize(delivery.github.state) : 'Checking'}
          </strong>
          {proposal.execution?.prUrl && (
            <a href={proposal.execution.prUrl}>
              Open PR #{proposal.execution.prNumber ?? '—'}
            </a>
          )}
          {delivery?.github.state === 'merged' && (
            <>
              <small>
                Commit <code>{delivery.github.mergeCommitSha}</code>; approved
                files{' '}
                {delivery.github.approvedFilesMatch ? 'match' : 'DO NOT MATCH'}
              </small>
              {delivery.deployed && (
                <a
                  href={`/catalog/default/component/${encodeURIComponent(
                    proposal.inputs.serviceName,
                  )}`}
                >
                  Open Catalog component
                </a>
              )}
            </>
          )}
          {(delivery?.github.state === 'unavailable' ||
            delivery?.github.state === 'source_mismatch') && (
            <small>
              {humanize(delivery.github.state)} ({delivery.github.reason})
            </small>
          )}
        </div>
        <div>
          <span>Argo CD</span>
          <strong>
            {delivery ? humanize(delivery.argoCd.state) : 'Checking'}
          </strong>
          {delivery?.argoCd.state === 'observed' && (
            <>
              <small>
                sync {delivery.argoCd.syncStatus}, health{' '}
                {delivery.argoCd.healthStatus}, revision{' '}
                {delivery.argoCd.revision ?? 'unknown'}, workload{' '}
                {delivery.argoCd.workloadKind} health{' '}
                {delivery.argoCd.workloadHealth}
                {`; approved merge ${
                  delivery.argoCd.includesApprovedMerge
                    ? 'included'
                    : 'not included'
                }`}
                {delivery.argoCd.conditions.length > 0 &&
                  `; conditions: ${delivery.argoCd.conditions.join(', ')}`}
              </small>
              {delivery.argoCd.applicationUrl && (
                <a href={delivery.argoCd.applicationUrl}>
                  Open Argo CD application
                </a>
              )}
            </>
          )}
          {(delivery?.argoCd.state === 'unavailable' ||
            delivery?.argoCd.state === 'source_mismatch') && (
            <small>
              {humanize(delivery.argoCd.state)} ({delivery.argoCd.reason})
            </small>
          )}
        </div>
      </div>
      {loading && (
        <p className="ag-muted" role="status">
          Refreshing delivery observation…
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div
        className={`ag-delivery__verdict ${
          delivery?.deployed ? 'ag-delivery__verdict--verified' : ''
        }`}
      >
        <span aria-hidden="true">{delivery?.deployed ? '✓' : '○'}</span>
        <strong>{verdict}</strong>
        {delivery && (
          <small>
            Observed at {new Date(delivery.checkedAt).toLocaleString()}
          </small>
        )}
      </div>
    </section>
  );
}
