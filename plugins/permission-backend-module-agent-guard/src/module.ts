import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { AgentGuardPolicy } from './policy/AgentGuardPolicy';

export const permissionModuleAgentGuard = createBackendModule({
  pluginId: 'permission',
  moduleId: 'agent-guard',
  register({ registerInit }) {
    registerInit({
      deps: {
        policy: policyExtensionPoint,
      },
      async init({ policy }) {
        policy.setPolicy(new AgentGuardPolicy());
      },
    });
  },
});
