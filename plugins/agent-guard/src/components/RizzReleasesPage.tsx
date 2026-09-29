import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { Container, Header } from '@backstage/ui';
import { useEffect, useState } from 'react';
import './ProposalsPage/ProposalsPage.css';

type Release = {
  releaseId: string;
  sourceCommit: string;
  expiresAt: string;
  recordDigest: string;
  eligibleForProposal: boolean;
  images: {
    frontend: { repository: string; digest: string };
    backend: { repository: string; digest: string };
  };
};
type Listing = {
  state: 'not_configured' | 'unavailable' | 'fixture' | 'available';
  items: Release[];
};

export function RizzReleasesPage() {
  const { fetch } = useApi(fetchApiRef);
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setListing(null);
    setError(false);
    setSelected('');
    fetch('plugin://agent-guard/rizz/releases')
      .then(async response => {
        if (!response.ok) throw new Error('Release request failed');
        const value = (await response.json()) as Listing;
        if (
          !['not_configured', 'unavailable', 'fixture', 'available'].includes(
            value.state,
          ) ||
          !Array.isArray(value.items)
        )
          throw new Error('Invalid listing');
        if (active) setListing(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [fetch, refresh]);
  const release = listing?.items.find(r => r.releaseId === selected);
  return (
    <Container>
      <Header title="Rizz.AI releases" />
      <div className="ag-page">
        <section className="ag-card ag-release-panel">
          <span className="ag-eyebrow">Read-only release evidence</span>
          <h1>One commit. Two immutable images.</h1>
          <p>
            Inspect the paired build before proposing a deployment. Browsing
            never publishes, provisions or deploys.
          </p>
          <p>
            <a href="/catalog/default/system/rizz-ai">
              Open Rizz.AI in the Catalog
            </a>
          </p>
          <button
            className="ag-button"
            type="button"
            onClick={() => setRefresh(v => v + 1)}
          >
            Refresh releases
          </button>
          {error && (
            <p role="alert">
              Release data unavailable. No release can be selected.
            </p>
          )}
          {!error && !listing && <p role="status">Loading releases…</p>}
          {!error && listing && (
            <>
              {listing.state === 'not_configured' && (
                <p role="status">
                  Trusted publisher not connected. No deployable releases exist
                  yet.
                </p>
              )}
              {listing.state === 'unavailable' && (
                <p role="alert">
                  Release source unavailable. No release can be selected.
                </p>
              )}
              {listing.state === 'fixture' && (
                <p role="status">
                  Fixture evidence only—not eligible for deployment proposals.
                </p>
              )}
              {listing.state === 'available' && !listing.items.length && (
                <p role="status">No verified, unexpired releases available.</p>
              )}
              {!!listing.items.length &&
                ['available', 'fixture'].includes(listing.state) && (
                  <p>
                    <label htmlFor="rizz-release">Inspect release </label>
                    <select
                      id="rizz-release"
                      value={selected}
                      onChange={e => setSelected(e.target.value)}
                    >
                      <option value="">Choose a release to inspect</option>
                      {listing.items.map(r => (
                        <option key={r.releaseId} value={r.releaseId}>
                          {r.releaseId}
                        </option>
                      ))}
                    </select>
                  </p>
                )}
            </>
          )}
          {release && (
            <div className="ag-notice">
              <p>
                Source commit: <code>{release.sourceCommit}</code>
              </p>
              <p>
                Record digest: <code>{release.recordDigest}</code>
              </p>
              <p>Available until: {release.expiresAt}</p>
              {(['frontend', 'backend'] as const).map(component => (
                <p key={component}>
                  {component}:{' '}
                  <code>
                    {release.images[component].repository}@
                    {release.images[component].digest}
                  </code>
                </p>
              ))}
              <p>
                {release.eligibleForProposal
                  ? 'Build evidence verified; this is not deployment approval.'
                  : 'Test fixture; no proposal allowed.'}
              </p>
            </div>
          )}
          <p>
            <a href="/rizz-deployments">Open governed Rizz.AI deployments</a>.
            The page remains disabled until an explicit cloud target and trusted
            release source are configured. Browsing never deploys.
          </p>
        </section>
      </div>
    </Container>
  );
}
