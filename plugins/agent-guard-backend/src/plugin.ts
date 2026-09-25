import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { scaffolderServiceRef } from '@backstage/plugin-scaffolder-node';
import { proposalActionSchema } from './domain';
import { DeliveryStatusObserver } from './deliveryStatus';
import { normalizeGitopsRepoUrl } from './gitops';
import { JevClient } from './jev';
import { createRouter } from './router';
import { ProposalService } from './services/ProposalService';

export function createAgentGuardPlugin(
  options: {
    jev?: JevClient;
    gitopsRepoUrl?: string;
    deliveryObserver?: DeliveryStatusObserver;
  } = {},
) {
  return createBackendPlugin({
    pluginId: 'agent-guard',
    register(env) {
      env.registerInit({
        deps: {
          actionsRegistry: actionsRegistryServiceRef,
          auth: coreServices.auth,
          catalog: catalogServiceRef,
          database: coreServices.database,
          httpAuth: coreServices.httpAuth,
          httpRouter: coreServices.httpRouter,
          logger: coreServices.logger,
          rootConfig: coreServices.rootConfig,
          scaffolder: scaffolderServiceRef,
          userInfo: coreServices.userInfo,
        },
        async init(deps) {
          const configuredAuthMode =
            deps.rootConfig.getOptionalString('auth.environment');
          const runtimeAuthMode =
            process.env.AGENT_GUARD_AUTH_MODE ?? 'guest-demo';
          if (
            runtimeAuthMode !== 'guest-demo' &&
            runtimeAuthMode !== 'github'
          ) {
            throw new Error('Unsupported AGENT_GUARD_AUTH_MODE');
          }
          if (configuredAuthMode && configuredAuthMode !== runtimeAuthMode) {
            throw new Error(
              'AGENT_GUARD_AUTH_MODE must match auth.environment; refusing to start with mismatched auth configuration',
            );
          }
          const proposals = await ProposalService.create({
            database: deps.database,
            catalog: deps.catalog,
            auth: deps.auth,
            scaffolder: deps.scaffolder,
            userInfo: deps.userInfo,
            jev: options.jev ?? new JevClient(process.env.TYPESAFE_API_KEY),
            logger: deps.logger,
            authMode: runtimeAuthMode,
            gitopsRepoUrl: normalizeGitopsRepoUrl(
              options.gitopsRepoUrl ?? process.env.AGENT_GUARD_GITOPS_REPO_URL,
            ),
            deliveryObserver:
              options.deliveryObserver ??
              new DeliveryStatusObserver({
                githubToken: process.env.GITHUB_TOKEN,
                argoCdUrl: process.env.AGENT_GUARD_ARGOCD_URL,
                argoCdToken: process.env.AGENT_GUARD_ARGOCD_TOKEN,
                argoCdCaBase64: process.env.AGENT_GUARD_ARGOCD_CA_B64,
              }),
          });

          deps.httpRouter.use(
            createRouter({ httpAuth: deps.httpAuth, proposals }),
          );

          deps.actionsRegistry.register({
            name: 'submit-proposal',
            title: 'Submit governed service proposal',
            description:
              'Submit a proposed staging service deployment for semantic and human review. This action never runs Scaffolder or deploys anything.',
            schema: {
              input: () => proposalActionSchema,
              output: z =>
                z.object({
                  id: z.string(),
                  status: z.enum([
                    'needs_clarification',
                    'pending_approval',
                    'approved',
                    'rejected',
                    'scaffolding',
                    'render_complete',
                    'execution_failed',
                    'publishing',
                    'pr_open',
                    'publish_failed',
                  ]),
                  reviewLane: z
                    .enum(['requester_confirmation', 'owner_review'])
                    .nullable(),
                  reasonCodes: z.array(z.string()),
                }),
            },
            attributes: {
              readOnly: false,
              destructive: false,
              idempotent: false,
            },
            action: async ({ input, credentials }) => {
              const record = await proposals.submit(
                input,
                credentials,
                'mcp_action',
              );
              return {
                output: {
                  id: record.id,
                  status: record.status,
                  reviewLane: record.reviewLane,
                  reasonCodes: record.reasonCodes,
                },
              };
            },
          });

          deps.actionsRegistry.register({
            name: 'get-proposal-status',
            title: 'Get proposal status',
            description:
              'Read the state of one of your Agent Guard proposals. Does not execute any change.',
            schema: {
              input: z => z.object({ id: z.string().uuid() }).strict(),
              output: z =>
                z.object({
                  id: z.string(),
                  status: z.enum([
                    'needs_clarification',
                    'pending_approval',
                    'approved',
                    'rejected',
                    'scaffolding',
                    'render_complete',
                    'execution_failed',
                    'publishing',
                    'pr_open',
                    'publish_failed',
                  ]),
                  reviewLane: z
                    .enum(['requester_confirmation', 'owner_review'])
                    .nullable(),
                  reasonCodes: z.array(z.string()),
                  taskId: z.string().optional(),
                  prUrl: z.string().optional(),
                }),
            },
            attributes: {
              readOnly: true,
              destructive: false,
              idempotent: true,
            },
            action: async ({ input, credentials }) => {
              const record = await proposals.get(input.id, credentials);
              return {
                output: {
                  id: record.id,
                  status: record.status,
                  reviewLane: record.reviewLane,
                  reasonCodes: record.reasonCodes,
                  taskId: record.execution?.taskId,
                  prUrl: record.execution?.prUrl,
                },
              };
            },
          });
        },
      });
    },
  });
}

export const agentGuardPlugin = createAgentGuardPlugin();
