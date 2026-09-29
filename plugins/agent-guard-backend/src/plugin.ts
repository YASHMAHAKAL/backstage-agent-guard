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
import { createReleaseCatalog } from './releaseSource';
import { createRouter } from './router';
import { ProposalService } from './services/ProposalService';
import {
  CloudProposalService,
  CloudServiceConfiguration,
  cloudStatusSchema,
} from './services/CloudProposalService';
import { cloudProposalInputSchema } from './cloudDomain';
import { createCloudConfiguration } from './cloudConfiguration';
import { cloudRuntimeChangeInputSchema } from './cloudRuntimeChange';
import { cloudRollbackInputSchema } from './cloudRollback';
import { retirementInputSchema } from './cloudRetirement';
import { InputError } from '@backstage/errors';
import {
  TerraformConfigurationReader,
  TerraformControlService,
} from './services/TerraformControlService';
import { GitHubTerraformConfigurationReader } from './terraformConfigurationReader';
import {
  GitHubTerraformCapacityPublisher,
  TerraformCapacityPublisher,
} from './terraformCapacityPublisher';

export function createAgentGuardPlugin(
  options: {
    jev?: JevClient;
    gitopsRepoUrl?: string;
    deliveryObserver?: DeliveryStatusObserver;
    // Backend-owned integration only. No environment flag or agent parameter
    // can substitute mocked/config-shaped evidence for authenticated readers.
    cloud?: CloudServiceConfiguration;
    terraform?: {
      runnerKey: Buffer;
      approvalKey: Buffer;
      expectedAccountId: string;
      expectedRunnerId: string;
      configurationReader: TerraformConfigurationReader;
      capacityPublisher?: TerraformCapacityPublisher;
    };
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

          const releases = createReleaseCatalog(deps.rootConfig);
          const cloudConfiguration =
            options.cloud ??
            createCloudConfiguration(deps.rootConfig, releases);
          if (cloudConfiguration && runtimeAuthMode !== 'github')
            throw new Error(
              'Cloud governance requires GitHub user authentication',
            );
          const cloudProposals = cloudConfiguration
            ? await CloudProposalService.create({
                database: deps.database,
                auth: deps.auth,
                userInfo: deps.userInfo,
                catalog: deps.catalog,
                scaffolder: deps.scaffolder,
                logger: deps.logger,
                jev: options.jev ?? new JevClient(process.env.TYPESAFE_API_KEY),
                configuration: cloudConfiguration,
              })
            : undefined;

          const terraformEnv = [
            process.env.AGENT_GUARD_TERRAFORM_REPO,
            process.env.AGENT_GUARD_TERRAFORM_GITHUB_TOKEN,
            process.env.AGENT_GUARD_TERRAFORM_RUNNER_KEY_B64,
            process.env.AGENT_GUARD_TERRAFORM_APPROVAL_KEY_B64,
            process.env.AGENT_GUARD_TERRAFORM_ACCOUNT_ID,
            process.env.AGENT_GUARD_TERRAFORM_RUNNER_ID,
          ];
          if (terraformEnv.some(Boolean) && !terraformEnv.every(Boolean))
            throw new Error('Incomplete Terraform control configuration');
          const capacityWriteToken =
            process.env.AGENT_GUARD_TERRAFORM_GITHUB_WRITE_TOKEN;
          const capacityActivation =
            process.env.AGENT_GUARD_TERRAFORM_CAPACITY_ACTIVATION;
          const capacityEvidence =
            process.env.AGENT_GUARD_TERRAFORM_CAPACITY_EVIDENCE_URL;
          if (
            [capacityWriteToken, capacityActivation, capacityEvidence].some(
              Boolean,
            ) &&
            (!terraformEnv.every(Boolean) ||
              !capacityWriteToken ||
              capacityWriteToken === terraformEnv[1] ||
              capacityWriteToken === process.env.GITHUB_TOKEN ||
              capacityActivation !== 'YES-REVIEWED-MEASURED-CAPACITY' ||
              !/^https:\/\/[^\s]+$/.test(capacityEvidence ?? ''))
          )
            throw new Error(
              'Capacity publishing needs reviewed measurement evidence and explicit activation',
            );
          if (terraformEnv.every(Boolean) && runtimeAuthMode !== 'github')
            throw new Error(
              'Terraform controls require GitHub user authentication',
            );
          const terraformRepo = terraformEnv[0]?.match(
            /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/,
          );
          if (terraformEnv.every(Boolean) && !terraformRepo)
            throw new Error('Invalid Terraform configuration repository');
          const decodeKey = (value: string) => {
            if (!/^[A-Za-z0-9+/]{43}=$/.test(value))
              throw new Error('Invalid Terraform control key encoding');
            return Buffer.from(value, 'base64');
          };
          const terraformProvider =
            options.terraform ??
            (terraformRepo
              ? {
                  runnerKey: decodeKey(terraformEnv[2]!),
                  approvalKey: decodeKey(terraformEnv[3]!),
                  expectedAccountId: terraformEnv[4]!,
                  expectedRunnerId: terraformEnv[5]!,
                  configurationReader: new GitHubTerraformConfigurationReader({
                    owner: terraformRepo[1],
                    repo: terraformRepo[2],
                    token: terraformEnv[1]!,
                  }),
                  ...(capacityWriteToken
                    ? {
                        capacityPublisher: new GitHubTerraformCapacityPublisher(
                          {
                            owner: terraformRepo[1],
                            repo: terraformRepo[2],
                            token: capacityWriteToken,
                          },
                        ),
                      }
                    : {}),
                }
              : undefined);
          if (terraformProvider && runtimeAuthMode !== 'github')
            throw new Error(
              'Terraform controls require GitHub user authentication',
            );
          const terraformControl = terraformProvider
            ? await TerraformControlService.create({
                database: deps.database,
                auth: deps.auth,
                userInfo: deps.userInfo,
                catalog: deps.catalog,
                ...terraformProvider,
              })
            : undefined;

          deps.httpRouter.use(
            createRouter({
              httpAuth: deps.httpAuth,
              proposals,
              releases: options.cloud?.releases ?? releases,
              cloudProposals,
              terraformControl,
            }),
          );

          if (cloudProposals) {
            deps.actionsRegistry.register({
              name: 'submit-rizz-retirement-proposal',
              title: 'Submit staged Rizz.AI retirement',
              description:
                'Propose the next bounded Rizz.AI staging retirement stage. A distinct platform reviewer must approve exact changes. This action cannot delete or deploy directly.',
              schema: {
                input: () => retirementInputSchema,
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
                    stage: z.enum([
                      'rizz_cloud_retire_ingress',
                      'rizz_cloud_retire_app',
                    ]),
                    reasonCodes: z.array(z.string()),
                  }),
              },
              attributes: {
                readOnly: false,
                destructive: false,
                idempotent: false,
              },
              action: async ({ input, credentials }) => {
                const record = await cloudProposals.submitRetirement(
                  input,
                  credentials,
                  'mcp_action',
                );
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    stage: record.snapshot.envelope.kind as
                      | 'rizz_cloud_retire_ingress'
                      | 'rizz_cloud_retire_app',
                    reasonCodes: record.reasonCodes,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'get-rizz-retirement-proposal-status',
              title: 'Get staged Rizz.AI retirement status',
              description:
                'Read an authorized retirement proposal status. Does not approve, publish, sync or delete.',
              schema: {
                input: z => z.object({ id: z.string().uuid() }).strict(),
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
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
                const record = await cloudProposals.get(input.id, credentials);
                if (
                  record.snapshot.envelope.kind !==
                    'rizz_cloud_retire_ingress' &&
                  record.snapshot.envelope.kind !== 'rizz_cloud_retire_app'
                )
                  throw new InputError('Not a retirement proposal');
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                    taskId: record.execution?.taskId,
                    prUrl: record.execution?.prUrl,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'submit-rizz-rollback-proposal',
              title: 'Submit governed Rizz.AI rollback',
              description:
                'Propose restoring one recorded healthy Rizz.AI staging deployment. Requires fresh artifact checks, Jev and distinct human review; never reverts Git or deploys directly.',
              schema: {
                input: () => cloudRollbackInputSchema,
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
                    reasonCodes: z.array(z.string()),
                  }),
              },
              attributes: {
                readOnly: false,
                destructive: false,
                idempotent: false,
              },
              action: async ({ input, credentials }) => {
                const record = await cloudProposals.submitRollback(
                  input,
                  credentials,
                  'mcp_action',
                );
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'submit-rizz-runtime-change-proposal',
              title: 'Submit governed Rizz.AI runtime change',
              description:
                'Propose a bounded replica change for an existing Rizz.AI EKS staging deployment. Requires semantic and distinct human review; never approves or deploys.',
              schema: {
                input: () => cloudRuntimeChangeInputSchema,
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
                    reasonCodes: z.array(z.string()),
                  }),
              },
              attributes: {
                readOnly: false,
                destructive: false,
                idempotent: false,
              },
              action: async ({ input, credentials }) => {
                const record = await cloudProposals.submitRuntime(
                  input,
                  credentials,
                  'mcp_action',
                );
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'submit-rizz-release-proposal',
              title: 'Submit governed Rizz.AI cloud release',
              description:
                'Submit a paired Rizz.AI release to EKS staging for semantic and distinct human review. Never approves, starts Scaffolder or deploys.',
              schema: {
                input: () => cloudProposalInputSchema,
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
                    reasonCodes: z.array(z.string()),
                  }),
              },
              attributes: {
                readOnly: false,
                destructive: false,
                idempotent: false,
              },
              action: async ({ input, credentials }) => {
                const record = await cloudProposals.submit(
                  input,
                  credentials,
                  'mcp_action',
                );
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'get-rizz-release-proposal-status',
              title: 'Get governed Rizz.AI release status',
              description:
                'Read an authorized cloud proposal status. No execution or sync.',
              schema: {
                input: z => z.object({ id: z.string().uuid() }).strict(),
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
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
                const record = await cloudProposals.get(input.id, credentials);
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                    taskId: record.execution?.taskId,
                    prUrl: record.execution?.prUrl,
                  },
                };
              },
            });
            deps.actionsRegistry.register({
              name: 'get-rizz-runtime-change-proposal-status',
              title: 'Get governed Rizz.AI runtime change status',
              description:
                'Read an authorized runtime-change proposal status. Never approves or deploys.',
              schema: {
                input: z => z.object({ id: z.string().uuid() }).strict(),
                output: z =>
                  z.object({
                    id: z.string().uuid(),
                    status: cloudStatusSchema,
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
                const record = await cloudProposals.get(input.id, credentials);
                if (
                  record.snapshot.envelope.kind !== 'rizz_cloud_runtime_change'
                )
                  throw new InputError('Not a runtime-change proposal');
                return {
                  output: {
                    id: record.id,
                    status: record.status,
                    reasonCodes: record.reasonCodes,
                    taskId: record.execution?.taskId,
                    prUrl: record.execution?.prUrl,
                  },
                };
              },
            });
          }

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
