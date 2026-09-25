import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';

import { rootRouteRef } from './routes';

export const page = PageBlueprint.make({
  params: {
    path: '/agent-guard',
    title: 'Agent Guard',
    icon: (
      <svg
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
    routeRef: rootRouteRef,
    loader: () =>
      import('./components/ProposalsPage').then(m => <m.ProposalsPage />),
  },
});

export const agentGuardPlugin = createFrontendPlugin({
  pluginId: 'agent-guard',
  extensions: [page],
  routes: {
    root: rootRouteRef,
  },
});
