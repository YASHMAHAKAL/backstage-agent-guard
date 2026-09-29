import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { createPublishGithubPullRequestAction } from '@backstage/plugin-scaffolder-backend-module-github';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createGuardedPublishAction, GuardClient } from './publishAction';
import {
  CloudGuardClient,
  ExactBaseCloudPublisher,
  createCloudPublishAction,
} from './cloudPublishAction';

export const agentGuardScaffolderModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'agent-guard',
  register({ registerInit }) {
    registerInit({
      deps: {
        actions: scaffolderActionsExtensionPoint,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        rootConfig: coreServices.rootConfig,
      },
      async init({ actions, auth, discovery, rootConfig }) {
        const integrations = ScmIntegrations.fromConfig(rootConfig);
        const githubAction = createPublishGithubPullRequestAction({
          integrations,
          config: rootConfig,
        });
        const guard = new GuardClient({ auth, discovery });
        actions.addActions(createGuardedPublishAction({ guard, githubAction }));
        // Private action only: no cloud template/config is enabled here.
        const credentials =
          DefaultGithubCredentialsProvider.fromIntegrations(integrations);
        actions.addActions(
          createCloudPublishAction({
            guard: new CloudGuardClient({ auth, discovery }),
            publisher: new ExactBaseCloudPublisher({
              getToken: async repository =>
                (
                  await credentials.getCredentials({
                    url: repository.replace(/\.git$/, ''),
                  })
                ).token ?? '',
            }),
          }),
        );
      },
    });
  },
});
