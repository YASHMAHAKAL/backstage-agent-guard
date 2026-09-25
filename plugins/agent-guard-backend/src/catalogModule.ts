import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { normalizeGitopsRepoUrl } from './gitops';
import { GitopsCatalogProvider } from './gitopsCatalogProvider';

export const agentGuardCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'agent-guard-gitops-discovery',
  register({ registerInit }) {
    registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        reader: coreServices.urlReader,
        scheduler: coreServices.scheduler,
      },
      async init({ catalog, logger, reader, scheduler }) {
        const repository = normalizeGitopsRepoUrl(
          process.env.AGENT_GUARD_GITOPS_REPO_URL,
        );
        if (!repository) {
          return;
        }
        const url = new URL(`https://${repository}`);
        catalog.addEntityProvider(
          new GitopsCatalogProvider({
            owner: url.searchParams.get('owner')!,
            repo: url.searchParams.get('repo')!,
            reader,
            scheduler,
            logger,
          }),
        );
      },
    });
  },
});
