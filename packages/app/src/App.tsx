import { createApp } from '@backstage/frontend-defaults';
import { SignInPage } from '@backstage/core-components';
import { configApiRef, githubAuthApiRef, useApi } from '@backstage/core-plugin-api';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import authPlugin from '@backstage/plugin-auth';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => {
      const config = useApi(configApiRef);
      const authMode = config.getString('auth.environment');
      if (authMode === 'guest-demo') {
        return <SignInPage {...props} providers={['guest']} />;
      }
      if (authMode === 'github') {
        return (
          <SignInPage
            {...props}
            provider={{
              id: 'github-auth-provider',
              title: 'GitHub',
              message: 'Sign in with your mapped GitHub identity',
              apiRef: githubAuthApiRef,
            }}
          />
        );
      }
      throw new Error(`Unsupported auth.environment: ${authMode}`);
    },
  },
});

export default createApp({
  features: [
    authPlugin,
    catalogPlugin,
    navModule,
    homeModule,
    createFrontendModule({ pluginId: 'app', extensions: [signInPage] }),
  ],
});
