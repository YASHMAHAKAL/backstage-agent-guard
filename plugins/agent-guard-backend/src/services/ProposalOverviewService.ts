import {
  AuthService,
  BackstageCredentials,
  DatabaseService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { z } from 'zod/v3';
import { CloudProposalService } from './CloudProposalService';
import { ProposalService } from './ProposalService';
import { canViewCloudProposal, getCloudViewer } from './cloudAccess';

const archivedCloudProposal = z.object({
  id: z.string().uuid(),
  requester: z.string(),
  status: z.string(),
  createdAt: z.string(),
  snapshot: z.object({
    envelope: z.object({
      kind: z.enum([
        'rizz_cloud_release',
        'rizz_cloud_runtime_change',
        'rizz_cloud_rollback',
        'rizz_cloud_retire_ingress',
        'rizz_cloud_retire_app',
      ]),
      policyVersion: z.string(),
      target: z.object({ owner: z.string() }),
      inputs: z.object({ releaseId: z.string() }).optional(),
    }),
  }),
});

type ArchivedCloudProposal = z.infer<typeof archivedCloudProposal>;

export type ProposalOverviewItem = {
  id: string;
  type: 'kind' | 'rizz';
  title: string;
  operation: string;
  owner: string;
  requester: string;
  status: string;
  createdAt: string;
  canReview: boolean;
  detailUrl?: string;
};

function cloudTitle(record: ArchivedCloudProposal): string {
  const kind = record.snapshot.envelope.kind;
  if (kind === 'rizz_cloud_release')
    return record.snapshot.envelope.inputs?.releaseId
      ? `Rizz.AI release · ${record.snapshot.envelope.inputs.releaseId}`
      : 'Rizz.AI paired release';
  if (kind === 'rizz_cloud_runtime_change') return 'Rizz.AI runtime change';
  if (kind === 'rizz_cloud_rollback') return 'Rizz.AI rollback';
  if (kind === 'rizz_cloud_retire_ingress')
    return 'Rizz.AI retirement · ingress';
  return 'Rizz.AI retirement · application';
}

function cloudItem(
  record: ArchivedCloudProposal,
  configured: boolean,
  canReview = false,
): ProposalOverviewItem {
  return {
    id: record.id,
    type: 'rizz',
    title: cloudTitle(record),
    operation: record.snapshot.envelope.kind,
    owner: record.snapshot.envelope.target.owner,
    requester: record.requester,
    status: record.status,
    createdAt: record.createdAt,
    canReview: configured && canReview,
    ...(configured
      ? {
          detailUrl: `/rizz-deployments?proposal=${encodeURIComponent(
            record.id,
          )}#review-queue`,
        }
      : {}),
  };
}

export class ProposalOverviewService {
  constructor(
    private readonly options: {
      auth: AuthService;
      userInfo: UserInfoService;
      catalog: typeof catalogServiceRef.T;
      database: DatabaseService;
      logger: LoggerService;
      proposals: ProposalService;
      cloudProposals?: CloudProposalService;
    },
  ) {}

  async list(credentials: BackstageCredentials) {
    if (!this.options.auth.isPrincipal(credentials, 'user'))
      throw new NotAllowedError('Requests require a user');

    const viewer = credentials.principal.userEntityRef;
    let kindState: 'available' | 'unavailable' = 'available';
    let kind: ProposalOverviewItem[] = [];
    try {
      kind = (await this.options.proposals.list(credentials)).map(
        (record): ProposalOverviewItem => ({
          id: record.id,
          type: 'kind',
          title: record.inputs.serviceName,
          operation: record.templateId,
          owner: record.inputs.requestedOwner,
          requester: record.requester,
          status: record.status,
          createdAt: record.createdAt,
          canReview: record.viewerPermissions.canReview,
          detailUrl: `/agent-guard/kind?proposal=${encodeURIComponent(
            record.id,
          )}`,
        }),
      );
    } catch (error) {
      kindState = 'unavailable';
      this.options.logger.warn('Kind request overview unavailable', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }

    let cloudState:
      | 'configured'
      | 'disabled'
      | 'restricted'
      | 'unavailable' = this.options.cloudProposals ? 'configured' : 'disabled';
    let cloud: ProposalOverviewItem[] = [];
    try {
      if (this.options.cloudProposals) {
        cloud = (await this.options.cloudProposals.list(credentials)).map(
          record => cloudItem(record, true, record.viewerPermissions.canReview),
        );
      } else {
        const cloudViewer = await getCloudViewer(this.options, credentials);
        const client = await this.options.database.getClient();
        if (await client.schema.hasTable('rizz_cloud_proposals')) {
          const rows = await client('rizz_cloud_proposals')
            .orderBy('created_at', 'desc')
            .limit(200);
          cloud = rows.flatMap(row => {
            let parsed: ReturnType<typeof archivedCloudProposal.safeParse>;
            try {
              parsed = archivedCloudProposal.safeParse(JSON.parse(row.record));
            } catch {
              return [];
            }
            if (
              !parsed.success ||
              !canViewCloudProposal(parsed.data, cloudViewer)
            )
              return [];
            return [cloudItem(parsed.data, false)];
          });
        }
      }
    } catch (error) {
      if (error instanceof NotAllowedError) {
        cloudState = 'restricted';
      } else {
        cloudState = 'unavailable';
        this.options.logger.warn('Cloud request overview unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    return {
      viewer,
      kindState,
      cloudState,
      items: [...kind, ...cloud].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    };
  }
}
