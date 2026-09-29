import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';

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
  extensions: [
    page,
    EntityContentBlueprint.make({
      name: 'rizz-control-center',
      params: {
        path: '/rizz-control-center',
        title: 'Rizz.AI Control Center',
        filter: entity =>
          (entity.kind.toLowerCase() === 'system' &&
            entity.metadata.name === 'rizz-ai') ||
          (entity.kind.toLowerCase() === 'component' &&
            entity.spec?.system === 'rizz-ai'),
        loader: () =>
          import('./components/RizzControlCenter').then(m => (
            <m.RizzControlCenter />
          )),
      },
    }),
    PageBlueprint.make({
      name: 'rizz-deployments',
      params: {
        path: '/rizz-deployments',
        title: 'Rizz.AI deployments',
        icon: (
          <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 17h16M7 13l5-9 5 9M12 4v16" />
          </svg>
        ),
        loader: () =>
          import('./components/CloudDeploymentsPage').then(m => (
            <m.CloudDeploymentsPage />
          )),
      },
    }),
    PageBlueprint.make({
      name: 'rizz-releases',
      params: {
        path: '/rizz-releases',
        title: 'Rizz.AI releases',
        icon: (
          <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="m12 3 9 5-9 5-9-5 9-5Z" />
            <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
          </svg>
        ),
        loader: () =>
          import('./components/RizzReleasesPage').then(m => (
            <m.RizzReleasesPage />
          )),
      },
    }),
    PageBlueprint.make({
      name: 'rizz-infrastructure',
      params: {
        path: '/rizz-infrastructure',
        title: 'Rizz.AI infrastructure',
        icon: (
          <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 7h18M6 7l2-4h8l2 4M5 7v12h14V7M9 12h6M9 16h6" />
          </svg>
        ),
        loader: () =>
          import('./components/RizzInfrastructurePage').then(m => (
            <m.RizzInfrastructurePage />
          )),
      },
    }),
  ],
  routes: {
    root: rootRouteRef,
  },
});
