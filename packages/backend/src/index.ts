/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';
import { agentGuardCatalogModule } from '@internal/backstage-plugin-agent-guard-backend';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(
  import('@internal/backstage-plugin-scaffolder-backend-module-agent-guard'),
);
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// Opt-in GitHub mode deliberately does not register the guest provider.
// app-config.portal.yaml also nulls its configuration, so an accidental
// config/mode mismatch fails closed instead of enabling shared guest login.
const authMode = process.env.AGENT_GUARD_AUTH_MODE ?? 'guest-demo';
if (authMode === 'github') {
  backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));
} else if (authMode === 'guest-demo') {
  backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
} else {
  throw new Error(`Unsupported AGENT_GUARD_AUTH_MODE: ${authMode}`);
}

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(agentGuardCatalogModule);
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// See https://backstage.io/docs/permissions/getting-started for how to create your own permission policy

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// user settings plugin
backend.add(import('@backstage/plugin-user-settings-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.add(import('@internal/backstage-plugin-agent-guard-backend'));
backend.add(
  import('@internal/backstage-plugin-permission-backend-module-agent-guard'),
);
backend.start();
