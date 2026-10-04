import { Progress } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { Container, Header } from '@backstage/ui';
import { useEffect, useState } from 'react';
import { humanize, statusTone } from './ProposalsPage/model';
import './ProposalsPage/ProposalsPage.css';
import './RequestOverviewPage.css';

type OverviewItem = {
  id: string;
  type: 'kind' | 'rizz';
  title: string;
  operation: string;
  owner: string;
  requester: string;
  status: string;
  createdAt: string;
  canReview: boolean;
  detailUrl?: string;
};

type Overview = {
  viewer: string;
  kindState: 'available' | 'unavailable';
  cloudState: 'configured' | 'disabled' | 'restricted' | 'unavailable';
  items: OverviewItem[];
};

type View = 'all' | 'mine' | 'review' | 'kind' | 'rizz';

export function RequestOverviewPage() {
  const { fetch } = useApi(fetchApiRef);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('plugin://agent-guard/overview', { signal: controller.signal })
      .then(async response => {
        if (!response.ok)
          throw new Error(`Request overview failed (${response.status})`);
        return (await response.json()) as Overview;
      })
      .then(data => {
        if (!Array.isArray(data.items))
          throw new Error('Invalid request overview');
        setOverview(data);
        setError(null);
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unknown error');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetch, refresh]);

  const items = overview?.items ?? [];
  const reviewCount = items.filter(item => item.canReview).length;
  const mineCount = items.filter(
    item => item.requester === overview?.viewer,
  ).length;
  const visible = items.filter(item => {
    if (view === 'mine' && item.requester !== overview?.viewer) return false;
    if (view === 'review' && !item.canReview) return false;
    if (view === 'kind' && item.type !== 'kind') return false;
    if (view === 'rizz' && item.type !== 'rizz') return false;
    return `${item.title} ${item.operation} ${item.owner} ${item.requester} ${item.status}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });

  const views: Array<{ key: View; label: string; count: number }> = [
    { key: 'all', label: 'All requests', count: items.length },
    { key: 'mine', label: 'My requests', count: mineCount },
    { key: 'review', label: 'Awaiting my review', count: reviewCount },
    {
      key: 'kind',
      label: 'Kind services',
      count: items.filter(item => item.type === 'kind').length,
    },
    {
      key: 'rizz',
      label: 'Rizz.AI',
      count: items.filter(item => item.type === 'rizz').length,
    },
  ];

  return (
    <>
      <Header title="Agent Guard" />
      <Container>
        <div className="ag-page ag-hub">
          <div className="ag-hero">
            <div>
              <span className="ag-eyebrow">Governed application changes</span>
              <h1>One place for every request.</h1>
              <p>
                Find Kind service and Rizz.AI proposals within your access
                scope. Open a request to inspect its frozen change, review
                decision, and delivery evidence.
              </p>
            </div>
            <div className="ag-hero__actions">
              <button
                className="ag-button"
                type="button"
                onClick={() => setRefresh(value => value + 1)}
              >
                Refresh requests
              </button>
              <a
                className="ag-button ag-button--primary"
                href="/agent-guard/kind?new=1"
              >
                New Kind request
              </a>
              {overview?.cloudState === 'configured' && (
                <a
                  className="ag-button ag-button--primary"
                  href="/rizz-deployments#paired-release-form"
                >
                  Propose Rizz.AI release
                </a>
              )}
            </div>
          </div>

          <div className="ag-overview" aria-label="Request counts">
            <div>
              <span>Visible requests</span>
              <strong>{items.length}</strong>
              <small>Across both application workflows</small>
            </div>
            <div>
              <span>My requests</span>
              <strong>{mineCount}</strong>
              <small>Submitted with this identity</small>
            </div>
            <div>
              <span>Awaiting my review</span>
              <strong>{reviewCount}</strong>
              <small>Current review eligibility</small>
            </div>
            <div>
              <span>Rizz.AI history</span>
              <strong>
                {items.filter(item => item.type === 'rizz').length}
              </strong>
              <small>Visible even when cloud operations are off</small>
            </div>
          </div>

          {overview?.cloudState === 'disabled' && (
            <div className="ag-notice" role="status">
              Cloud operations are off. Authorized Rizz.AI requests remain in
              this read-only history; start the configured cloud portal profile
              to open their detailed review pages.
            </div>
          )}
          {overview?.cloudState === 'restricted' && (
            <div className="ag-notice" role="status">
              Rizz.AI history requires a mapped, non-guest Backstage user.
            </div>
          )}
          {overview?.kindState === 'unavailable' && (
            <div className="ag-notice ag-notice--warning" role="status">
              Kind requests could not be read right now. Rizz.AI history may
              still be available below.
            </div>
          )}
          {overview?.cloudState === 'unavailable' && (
            <div className="ag-notice ag-notice--warning" role="status">
              Rizz.AI requests could not be read right now. Kind requests may
              still be available below.
            </div>
          )}
          {error && (
            <div className="ag-notice ag-notice--error" role="alert">
              {error}
            </div>
          )}

          <section
            className="ag-card ag-hub__queue"
            aria-labelledby="ag-hub-title"
          >
            <div className="ag-hub__heading">
              <div>
                <span className="ag-eyebrow">Request history</span>
                <h2 id="ag-hub-title">Find a proposal</h2>
                <p>Opening a request does not approve or execute it.</p>
              </div>
              <div className="ag-hub__links">
                <a href="/agent-guard/kind">Kind service requests</a>
                <a href="/rizz-deployments">Rizz.AI deployments</a>
                <a href="/rizz-infrastructure">Platform infrastructure</a>
              </div>
            </div>

            <div className="ag-hub__controls">
              <div
                className="ag-filter"
                role="group"
                aria-label="Request filter"
              >
                {views.map(option => (
                  <button
                    key={option.key}
                    type="button"
                    className={view === option.key ? 'ag-filter__active' : ''}
                    aria-pressed={view === option.key}
                    onClick={() => setView(option.key)}
                  >
                    {option.label} <span>{option.count}</span>
                  </button>
                ))}
              </div>
              <label className="ag-hub__search">
                <span className="ag-visually-hidden">Search requests</span>
                <input
                  type="search"
                  placeholder="Search request, owner, requester, status"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </label>
            </div>

            {loading && (
              <div className="ag-loading" role="status">
                <Progress /> Loading requests…
              </div>
            )}
            {!loading && !error && visible.length === 0 && (
              <p className="ag-empty">
                {items.length === 0
                  ? 'No requests are visible to this account.'
                  : 'No requests match this view.'}
              </p>
            )}
            {!loading && visible.length > 0 && (
              <div className="ag-hub__table-wrap">
                <table className="ag-hub__table">
                  <thead>
                    <tr>
                      <th scope="col">Request</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Requester</th>
                      <th scope="col">Status</th>
                      <th scope="col">Submitted</th>
                      <th scope="col">Next step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(item => (
                      <tr key={`${item.type}:${item.id}`}>
                        <td>
                          <span className="ag-hub__type">
                            {item.type === 'kind' ? 'Kind service' : 'Rizz.AI'}
                          </span>
                          {item.detailUrl ? (
                            <a className="ag-hub__title" href={item.detailUrl}>
                              {item.title}
                            </a>
                          ) : (
                            <strong className="ag-hub__title">
                              {item.title}
                            </strong>
                          )}
                          <small>{humanize(item.operation)}</small>
                        </td>
                        <td>{item.owner}</td>
                        <td>{item.requester}</td>
                        <td>
                          <span
                            className={`ag-pill ag-pill--${statusTone(
                              item.status,
                            )}`}
                          >
                            {humanize(item.status)}
                          </span>
                        </td>
                        <td>
                          <time dateTime={item.createdAt}>
                            {new Date(item.createdAt).toLocaleString()}
                          </time>
                        </td>
                        <td>
                          {item.detailUrl ? (
                            <a href={item.detailUrl}>
                              {item.canReview
                                ? 'Review request'
                                : 'Open request'}
                            </a>
                          ) : (
                            <span className="ag-muted">Read-only history</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </Container>
    </>
  );
}
