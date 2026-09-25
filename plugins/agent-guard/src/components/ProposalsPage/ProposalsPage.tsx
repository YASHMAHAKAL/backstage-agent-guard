import { Progress } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { Container, Header } from '@backstage/ui';
import { useEffect, useState } from 'react';
import { CreateProposalForm } from './CreateProposalForm';
import { DeliveryPanel } from './DeliveryPanel';
import { JevPanel } from './JevPanel';
import {
  DeliveryStatus,
  humanize,
  intentSourceLabel,
  Proposal,
  statusTone,
  submissionLabel,
} from './model';
import './ProposalsPage.css';

export function ProposalsPage() {
  const { fetch } = useApi(fetchApiRef);
  const [items, setItems] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [snapshotReviewed, setSnapshotReviewed] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submissionNotice, setSubmissionNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch('plugin://agent-guard/proposals')
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Proposal request failed (${response.status})`);
        }
        return (await response.json()) as { items: Proposal[] };
      })
      .then(data => {
        if (active) {
          setItems(data.items);
          setError(null);
          setLoading(false);
        }
      })
      .catch(cause => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Unknown error');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [fetch, refresh]);

  const visibleItems = items
    .filter(item => filter === 'all' || item.viewerPermissions.canReview)
    .filter(item =>
      `${item.inputs.serviceName} ${item.templateId} ${item.inputs.requestedOwner}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const selected =
    visibleItems.find(item => item.id === selectedId) ?? visibleItems[0];
  const activeProposalId = selected?.id;
  const reviewCount = items.filter(
    item => item.viewerPermissions.canReview,
  ).length;
  const heldCount = items.filter(
    item => item.status === 'needs_clarification',
  ).length;
  const deliveryCount = items.filter(item =>
    [
      'approved',
      'scaffolding',
      'render_complete',
      'publishing',
      'pr_open',
    ].includes(item.status),
  ).length;

  useEffect(() => {
    if (!activeProposalId) {
      setDelivery(null);
      setDeliveryError(null);
      setDeliveryLoading(false);
      return undefined;
    }
    let active = true;
    setDelivery(null);
    setDeliveryError(null);
    setDeliveryLoading(true);
    fetch(`plugin://agent-guard/proposals/${activeProposalId}/delivery`)
      .then(async response => {
        if (!response.ok) {
          throw new Error(
            `Delivery status request failed (${response.status})`,
          );
        }
        return (await response.json()) as DeliveryStatus;
      })
      .then(value => {
        if (active) {
          setDelivery(value);
          setDeliveryError(null);
          setDeliveryLoading(false);
        }
      })
      .catch(cause => {
        if (active) {
          setDeliveryError(
            cause instanceof Error ? cause.message : 'Unknown error',
          );
          setDeliveryLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [activeProposalId, fetch, refresh]);

  async function decide(decision: 'approve' | 'reject') {
    if (!selected?.snapshot || !selected.viewerPermissions.canReview) {
      return;
    }
    if (decision === 'approve' && !snapshotReviewed) {
      return;
    }
    setDeciding(true);
    setError(null);
    try {
      const response = await fetch(
        `plugin://agent-guard/proposals/${selected.id}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            digest: selected.snapshot.digest,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
          }),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Review failed (${response.status})${body ? `: ${body}` : ''}`,
        );
      }
      const updated = (await response.json()) as Proposal;
      setItems(current =>
        current.map(item => (item.id === updated.id ? updated : item)),
      );
      setFilter('all');
      setSelectedId(updated.id);
      setComment('');
      setSnapshotReviewed(false);
      setRefresh(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setDeciding(false);
    }
  }

  return (
    <>
      <Header title="Agent Guard" />
      <Container>
        <div className="ag-page">
          <div className="ag-hero">
            <div>
              <span className="ag-eyebrow">Platform change control</span>
              <h1>Service proposals, clearly reviewed.</h1>
              <p>
                Compare declared intent with the exact change, approve a frozen
                snapshot, and follow delivery from Scaffolder to Argo CD.
              </p>
            </div>
            <div className="ag-hero__actions">
              <button
                className="ag-button ag-button--hero"
                type="button"
                onClick={() => setRefresh(value => value + 1)}
              >
                <span aria-hidden="true">↻</span> Refresh
              </button>
              <button
                className="ag-button ag-button--primary"
                type="button"
                aria-expanded={creating}
                aria-controls="ag-create-form"
                onClick={() => {
                  setCreating(current => !current);
                  setSubmissionNotice(null);
                }}
              >
                {creating ? 'Close form' : '+ New proposal'}
              </button>
            </div>
          </div>

          {creating && (
            <CreateProposalForm
              onClose={() => setCreating(false)}
              onSubmitted={created => {
                setItems(current => [
                  created,
                  ...current.filter(item => item.id !== created.id),
                ]);
                setSelectedId(created.id);
                setFilter('all');
                setQuery('');
                setCreating(false);
                setSubmissionNotice(
                  `${created.inputs.serviceName} submitted (${humanize(
                    created.status,
                  )}). No Scaffolder task has started.`,
                );
                setRefresh(value => value + 1);
              }}
            />
          )}

          <div className="ag-overview" aria-label="Proposal overview">
            <div>
              <span>Visible proposals</span>
              <strong>{items.length}</strong>
              <small>Within your access scope</small>
            </div>
            <div>
              <span>Ready for your review</span>
              <strong>{reviewCount}</strong>
              <small>Requires an eligible owner</small>
            </div>
            <div>
              <span>Needs clarification</span>
              <strong>{heldCount}</strong>
              <small>No approval available</small>
            </div>
            <div>
              <span>In delivery</span>
              <strong>{deliveryCount}</strong>
              <small>PR and deployment are separate</small>
            </div>
          </div>

          {submissionNotice && (
            <div className="ag-notice ag-notice--success" role="status">
              {submissionNotice}
            </div>
          )}

          {loading && (
            <div className="ag-loading" role="status">
              <Progress /> Loading proposals…
            </div>
          )}
          {error && (
            <div className="ag-notice ag-notice--error" role="alert">
              {error}
            </div>
          )}

          <div className="ag-workspace">
            <aside className="ag-card ag-queue" aria-label="Proposal queue">
              <div className="ag-queue__top">
                <span className="ag-eyebrow">Your workspace</span>
                <h2>Proposals</h2>
                <p>Review eligible changes or inspect delivery evidence.</p>
              </div>
              <div
                className="ag-filter"
                role="group"
                aria-label="Proposal filter"
              >
                <button
                  type="button"
                  className={filter === 'all' ? 'ag-filter__active' : ''}
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  All visible <span>{items.length}</span>
                </button>
                <button
                  type="button"
                  className={filter === 'review' ? 'ag-filter__active' : ''}
                  aria-pressed={filter === 'review'}
                  onClick={() => setFilter('review')}
                >
                  Can review <span>{reviewCount}</span>
                </button>
              </div>
              <label className="ag-search">
                <span className="ag-visually-hidden">Search proposals</span>
                <input
                  type="search"
                  placeholder="Search service, owner, template"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </label>
              <div className="ag-queue__list">
                {!loading && visibleItems.length === 0 && (
                  <div className="ag-empty">
                    {items.length === 0
                      ? 'No proposals are visible to this account.'
                      : 'No proposals match this view.'}
                  </div>
                )}
                {visibleItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`ag-queue-item ${
                      selected?.id === item.id ? 'ag-queue-item--selected' : ''
                    }`}
                    aria-pressed={selected?.id === item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setComment('');
                      setSnapshotReviewed(false);
                    }}
                  >
                    <span className="ag-queue-item__top">
                      <strong>{item.inputs.serviceName}</strong>
                      <span
                        className={`ag-status-dot ag-status-dot--${statusTone(
                          item.status,
                        )}`}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="ag-queue-item__meta">
                      {humanize(item.templateId)} · {item.inputs.environment}
                    </span>
                    <span className="ag-queue-item__bottom">
                      <span>{humanize(item.status)}</span>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleDateString()}
                      </time>
                    </span>
                  </button>
                ))}
              </div>
            </aside>

            {selected ? (
              <div
                className="ag-detail"
                role="region"
                aria-label="Proposal details"
              >
                <div className="ag-card ag-detail__header">
                  <div>
                    <span className="ag-eyebrow">Proposal {selected.id}</span>
                    <h2>{selected.inputs.serviceName}</h2>
                    <p>{selected.inputs.description}</p>
                    <div className="ag-detail__meta">
                      <span>{selected.inputs.environment}</span>
                      <span>{selected.inputs.requestedOwner}</span>
                      <span>{humanize(selected.templateId)}</span>
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
                    <section
                      className="ag-card"
                      aria-labelledby="ag-change-heading"
                    >
                      <div className="ag-section-heading">
                        <div>
                          <span className="ag-eyebrow">Review the request</span>
                          <h3 id="ag-change-heading">
                            Intent and proposed change
                          </h3>
                        </div>
                      </div>
                      <div className="ag-compare">
                        <div>
                          <span className="ag-compare__label">
                            Declared intent
                          </span>
                          <p>{selected.declaredIntent}</p>
                          <small>
                            Intent provenance:{' '}
                            {intentSourceLabel(selected.intentSource)} (not
                            cryptographically verified user words)
                          </small>
                        </div>
                        <div>
                          <span className="ag-compare__label">
                            Proposed execution
                          </span>
                          <dl className="ag-facts">
                            <div>
                              <dt>Template</dt>
                              <dd>{selected.templateId}</dd>
                            </div>
                            <div>
                              <dt>Owner</dt>
                              <dd>{selected.inputs.requestedOwner}</dd>
                            </div>
                            <div>
                              <dt>Environment</dt>
                              <dd>{selected.inputs.environment}</dd>
                            </div>
                            {selected.inputs.schedule && (
                              <div>
                                <dt>Schedule</dt>
                                <dd>
                                  <code>{selected.inputs.schedule}</code>
                                </dd>
                              </div>
                            )}
                          </dl>
                        </div>
                      </div>
                      <div className="ag-provenance">
                        <span>Requester: {selected.requester}</span>
                        <span>
                          Submission:{' '}
                          <strong>
                            {submissionLabel(selected.submissionChannel)}
                          </strong>
                        </span>
                      </div>
                    </section>

                    <JevPanel semantic={selected.semantic} />

                    <section
                      className="ag-card"
                      aria-labelledby="ag-files-heading"
                    >
                      <div className="ag-section-heading">
                        <div>
                          <span className="ag-eyebrow">
                            Frozen execution envelope
                          </span>
                          <h3 id="ag-files-heading">
                            Exact files to be created
                          </h3>
                        </div>
                        {selected.snapshot && (
                          <span className="ag-pill ag-pill--neutral">
                            {selected.snapshot.files.length} files
                          </span>
                        )}
                      </div>
                      {selected.snapshot ? (
                        <>
                          <p className="ag-muted">
                            Approval binds the template, inputs, GitOps target,
                            and every file hash to one digest.
                          </p>
                          <div className="ag-target">
                            <span>GitOps target</span>
                            <code>
                              {
                                selected.snapshot.envelope.gitopsTarget
                                  .repository
                              }{' '}
                              @ {selected.snapshot.envelope.gitopsTarget.branch}
                              /{selected.snapshot.envelope.gitopsTarget.path}
                            </code>
                            <small>
                              {selected.snapshot.envelope.gitopsTarget
                                .publishEnabled
                                ? 'A guarded PR may open only after approval.'
                                : 'Render-only: GitOps publishing is not configured.'}
                            </small>
                          </div>
                          <div className="ag-files">
                            {selected.snapshot.files.map(file => (
                              <details className="ag-file" key={file.path}>
                                <summary>
                                  <span aria-hidden="true">▸</span>
                                  <span>{file.path}</span>
                                  <small>View file</small>
                                </summary>
                                <div className="ag-file__body">
                                  <span>SHA-256</span>
                                  <code>{file.sha256}</code>
                                  <pre>{file.content}</pre>
                                </div>
                              </details>
                            ))}
                          </div>
                          <details className="ag-disclosure">
                            <summary>
                              Snapshot metadata and full approval digest
                            </summary>
                            <div className="ag-disclosure__body">
                              <dl className="ag-facts ag-facts--stacked">
                                <div>
                                  <dt>Approval digest</dt>
                                  <dd>
                                    <code>{selected.snapshot.digest}</code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Template version</dt>
                                  <dd>
                                    {
                                      selected.snapshot.envelope.template
                                        .version
                                    }
                                  </dd>
                                </div>
                                <div>
                                  <dt>Template digest</dt>
                                  <dd>
                                    <code>
                                      {
                                        selected.snapshot.envelope.template
                                          .digest
                                      }
                                    </code>
                                  </dd>
                                </div>
                                <div>
                                  <dt>Policy version</dt>
                                  <dd>
                                    {selected.snapshot.envelope.policyVersion}
                                  </dd>
                                </div>
                              </dl>
                            </div>
                          </details>
                        </>
                      ) : (
                        <div className="ag-notice ag-notice--warning">
                          This historical proposal has no frozen snapshot.
                          Submit a new proposal before review.
                        </div>
                      )}
                    </section>
                  </div>

                  <aside
                    className="ag-card ag-review-panel"
                    aria-labelledby="ag-review-heading"
                  >
                    <span className="ag-eyebrow">Decision gate</span>
                    <h3 id="ag-review-heading">Human review</h3>
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
                    <p>{selected.viewerPermissions.reason}</p>
                    <div className="ag-policy">
                      <span>Deterministic policy</span>
                      <strong>
                        {humanize(selected.reviewLane ?? 'no_review_lane')}
                      </strong>
                      <ul>
                        {selected.reasonCodes.map(reason => (
                          <li key={reason}>{humanize(reason)}</li>
                        ))}
                      </ul>
                    </div>
                    {selected.snapshot && (
                      <div className="ag-digest">
                        <span>Approval digest</span>
                        <code>{selected.snapshot.digest}</code>
                      </div>
                    )}
                    {selected.viewerPermissions.canReview &&
                      selected.snapshot && (
                        <div className="ag-review-actions">
                          <label htmlFor="review-comment">
                            Review comment (optional)
                          </label>
                          <textarea
                            id="review-comment"
                            value={comment}
                            maxLength={500}
                            rows={3}
                            onChange={event => setComment(event.target.value)}
                            placeholder="Add context for the audit history"
                          />
                          <label className="ag-confirm">
                            <input
                              type="checkbox"
                              checked={snapshotReviewed}
                              onChange={event =>
                                setSnapshotReviewed(event.target.checked)
                              }
                            />
                            <span>
                              I reviewed the exact files and approval digest
                              shown here.
                            </span>
                          </label>
                          <button
                            className="ag-button ag-button--primary"
                            type="button"
                            disabled={deciding || !snapshotReviewed}
                            onClick={() => decide('approve')}
                          >
                            Approve exact snapshot
                          </button>
                          <button
                            className="ag-button ag-button--danger"
                            type="button"
                            disabled={deciding}
                            onClick={() => decide('reject')}
                          >
                            Reject proposal
                          </button>
                        </div>
                      )}
                    {selected.decision && (
                      <div className="ag-decision-record">
                        <strong>
                          {selected.decision.decision === 'approve'
                            ? 'Approved'
                            : 'Rejected'}
                        </strong>
                        <span>
                          by {selected.decision.reviewer} at{' '}
                          {new Date(
                            selected.decision.decidedAt,
                          ).toLocaleString()}
                        </span>
                        <small>Against {selected.decision.digest}</small>
                        {selected.decision.comment && (
                          <p>{selected.decision.comment}</p>
                        )}
                      </div>
                    )}
                  </aside>
                </div>

                <DeliveryPanel
                  proposal={selected}
                  delivery={delivery}
                  loading={deliveryLoading}
                  error={deliveryError}
                />

                <details className="ag-card ag-audit">
                  <summary>Audit history</summary>
                  <ol>
                    {(selected.auditTrail ?? []).map((event, index) => (
                      <li key={`${event.type}-${event.at}-${index}`}>
                        <strong>{humanize(event.type)}</strong> by {event.actor}{' '}
                        at {new Date(event.at).toLocaleString()}
                        <code>{event.digest}</code>
                        {event.comment && <span>— {event.comment}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
            ) : (
              <div className="ag-card ag-empty-detail">
                <span aria-hidden="true">◇</span>
                <h2>No proposal selected</h2>
                <p>
                  Choose a visible proposal to inspect review and delivery
                  evidence.
                </p>
              </div>
            )}
          </div>
        </div>
      </Container>
    </>
  );
}
