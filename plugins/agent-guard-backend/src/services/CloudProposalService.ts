import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  AuthService,
  BackstageCredentials,
  DatabaseService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { ScaffolderService } from '@backstage/plugin-scaffolder-node';
import { z } from 'zod/v3';
import { cloudProposalInputSchema } from '../cloudDomain';
import {
  CloudFrozenSnapshot,
  cloudGitopsBaseSchema,
  cloudSnapshotHasIntegrity,
  createCloudFrozenSnapshot,
  inspectCloudGitopsFiles,
  revalidateCloudSnapshot,
} from '../cloudSnapshot';
import {
  CloudTarget,
  CloudTargetMetadata,
  cloudTargetMetadataSchema,
  cloudTargetSchema,
} from '../cloudTarget';
import {
  decideReview,
  proposalDecisionSchema,
  SemanticResult,
} from '../domain';
import { JevClient } from '../jev';
import { ReleaseCatalog } from '../releases';
import { SubmissionChannel } from '../snapshot';
import { cloudTemplateMatches } from '../cloudTemplate';
import { CloudDeliveryReader, emptyCloudDelivery } from '../cloudDelivery';
import {
  cloudRuntimeChangeInputSchema,
  previewCloudRuntimeChange,
} from '../cloudRuntimeChange';
import {
  CloudRuntimeSnapshot,
  cloudRuntimeSnapshotHasIntegrity,
  createCloudRuntimeSnapshot,
  revalidateCloudRuntimeSnapshot,
} from '../cloudRuntimeSnapshot';
import {
  applicationReviewerGroups,
  applicationReviewPolicy,
  reviewerGroupsForPolicy,
} from '../cloudReviewPolicy';
import {
  CloudVerifiedDeployment,
  verifiedCloudDeployment,
  verifiedDeploymentSummary,
} from '../cloudHistory';
import {
  cloudRollbackInputSchema,
  rollbackPreservesProtectedConfiguration,
} from '../cloudRollback';
import { canonicalize } from '../snapshot';
import { CloudMetricsReader } from '../cloudMetrics';
import {
  CloudRetirementSnapshot,
  cloudRetirementSnapshotHasIntegrity,
  createCloudRetirementSnapshot,
  retirementInputSchema,
} from '../cloudRetirement';

const statuses = [
  'needs_clarification',
  'pending_approval',
  'approved',
  'rejected',
  'scaffolding',
  'publishing',
  'pr_open',
  'execution_failed',
] as const;
export const cloudStatusSchema = z.enum(statuses);
const image = z
  .string()
  .max(250)
  .regex(
    /^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/rizz-staging-(frontend|backend)@sha256:[a-f0-9]{64}$/,
  );
export const currentCloudStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }).strict(),
  z.object({ state: z.literal('retiring') }).strict(),
  z.object({ state: z.literal('retired') }).strict(),
  z
    .object({
      state: z.literal('present'),
      frontendImage: image,
      backendImage: image,
      frontendReplicas: z.number().int().min(1).max(2),
      backendReplicas: z.number().int().min(1).max(2),
      geminiModel: z.string().min(1).max(100),
      frontendExposure: z.literal('restricted_alb_https'),
      backendExposure: z.literal('clusterip'),
    })
    .strict(),
]);

// Backend-only adapter contract. A real implementation must use authenticated
// independent AWS/ACM/ALB/GitHub reads, never config claims or agent JSON as proof.
export interface CloudReaders {
  mode: 'authenticated' | 'fixture';
  resolveTarget?(raw: unknown, signal: AbortSignal): Promise<CloudTarget>;
  verifyTarget(
    target: CloudTarget,
    signal: AbortSignal,
    phase?: 'initial' | 'deployed',
  ): Promise<void>;
  readGitops(
    target: CloudTarget,
    signal: AbortSignal,
  ): Promise<{
    base: unknown;
    currentState: unknown;
    // Verified bytes from the same pinned Git tree. Runtime previews require
    // these; deploy-only adapters may omit them until that path is enabled.
    contents?: Record<string, string>;
  }>;
  readRetirementCleanup?(
    target: CloudTarget,
    signal: AbortSignal,
  ): Promise<{
    checkedAt: string;
    ingressAbsent: true;
    albAbsent: true;
    targetGroupsAbsent: true;
  }>;
  readRetiredAppCleanup?(
    target: CloudTarget,
    signal: AbortSignal,
  ): Promise<{ checkedAt: string; appResourcesAbsent: true }>;
  readPullRequest?(
    target: CloudTarget,
    number: number,
    signal: AbortSignal,
  ): Promise<unknown>;
  isAncestor?(
    target: CloudTarget,
    ancestor: string,
    revision: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  readGitopsRevision?(
    target: CloudTarget,
    revision: string,
    signal: AbortSignal,
  ): Promise<{ base: unknown; contents?: Record<string, string> }>;
}
export interface CloudServiceConfiguration {
  target: unknown;
  submitterGroups: string[];
  releases: ReleaseCatalog;
  readers: CloudReaders;
  delivery?: CloudDeliveryReader;
  metrics?: CloudMetricsReader;
}
type Client = Awaited<ReturnType<DatabaseService['getClient']>>;
type Viewer = { ref: string; groups: string[] };
export interface CloudProposalRecord {
  id: string;
  version: number;
  requester: string;
  status: z.infer<typeof cloudStatusSchema>;
  reasonCodes: string[];
  semantic: SemanticResult;
  snapshot:
    | CloudFrozenSnapshot
    | CloudRuntimeSnapshot
    | CloudRetirementSnapshot;
  currentState: z.infer<typeof currentCloudStateSchema>;
  createdAt: string;
  decision?: {
    decision: 'approve' | 'reject';
    reviewer: string;
    digest: string;
    at: string;
    comment?: string;
  };
  execution?: {
    state: 'claimed' | 'task_started' | 'publishing' | 'pr_open' | 'failed';
    claimHash: string;
    taskId?: string;
    prUrl?: string;
    prNumber?: number;
    errorCode?: string;
  };
  audit: Array<{ event: string; actor: string; at: string; digest: string }>;
}
export type CloudProposalView = Omit<CloudProposalRecord, 'execution'> & {
  execution?: Omit<NonNullable<CloudProposalRecord['execution']>, 'claimHash'>;
  viewerPermissions: { canReview: boolean };
};
const claimHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export class CloudProposalService {
  private constructor(
    private readonly client: Client,
    private readonly options: {
      auth: AuthService;
      userInfo: UserInfoService;
      catalog: typeof catalogServiceRef.T;
      scaffolder: ScaffolderService;
      jev: JevClient;
      logger: LoggerService;
      configuration: CloudServiceConfiguration;
    },
    private readonly configuredTarget: CloudTarget | CloudTargetMetadata,
    private readonly resolvedTarget?: CloudTarget,
  ) {}

  private get target(): CloudTarget {
    if (!this.resolvedTarget)
      throw new ServiceUnavailableError('Cloud HTTPS metadata unavailable');
    return this.resolvedTarget;
  }

  // A separate service instance pins one target for the whole operation. Never
  // mutate a shared target while concurrent requests are rendering snapshots.
  private async forRequest(): Promise<CloudProposalService> {
    if (this.resolvedTarget) return this;
    try {
      const target = await this.options.configuration.readers.resolveTarget?.(
        this.configuredTarget,
        AbortSignal.timeout(10000),
      );
      const resolved = cloudTargetSchema.parse(target);
      const metadata = cloudTargetMetadataSchema.parse({
        ...resolved,
        ingress: { operatorCidr: resolved.ingress.operatorCidr },
      });
      if (canonicalize(metadata) !== canonicalize(this.configuredTarget))
        throw new Error('Cloud target differs from configured identity');
      return new CloudProposalService(
        this.client,
        this.options,
        this.configuredTarget,
        resolved,
      );
    } catch {
      throw new ServiceUnavailableError('Cloud HTTPS metadata unavailable');
    }
  }

  static async create(options: {
    database: DatabaseService;
    auth: AuthService;
    userInfo: UserInfoService;
    catalog: typeof catalogServiceRef.T;
    scaffolder: ScaffolderService;
    jev: JevClient;
    logger: LoggerService;
    configuration: CloudServiceConfiguration;
  }) {
    if (options.configuration.readers.mode !== 'authenticated')
      throw new ServiceUnavailableError(
        'Authenticated cloud readers are required',
      );
    const fullTarget = cloudTargetSchema.safeParse(
      options.configuration.target,
    );
    const target = fullTarget.success
      ? fullTarget.data
      : cloudTargetMetadataSchema.parse(options.configuration.target);
    if (!fullTarget.success && !options.configuration.readers.resolveTarget)
      throw new ServiceUnavailableError('Cloud HTTPS metadata reader required');
    z.array(z.string().regex(/^group:default\/[a-z0-9][a-z0-9-]*$/))
      .min(1)
      .max(10)
      .parse(options.configuration.submitterGroups);
    const client = await options.database.getClient();
    if (!(await client.schema.hasTable('rizz_cloud_proposals'))) {
      await client.schema.createTable('rizz_cloud_proposals', table => {
        table.string('id').primary();
        table.integer('version').notNullable();
        table.string('requester').notNullable().index();
        table.string('status').notNullable().index();
        table.text('record').notNullable();
        table.timestamp('created_at').notNullable();
      });
    }
    if (!(await client.schema.hasTable('rizz_verified_deployments'))) {
      await client.schema.createTable('rizz_verified_deployments', table => {
        table.string('proposal_id').primary();
        table.timestamp('verified_at').notNullable().index();
        table.text('record').notNullable();
      });
    }
    return new CloudProposalService(
      client,
      options,
      target,
      fullTarget.success ? fullTarget.data : undefined,
    );
  }

  private async viewer(credentials: BackstageCredentials): Promise<Viewer> {
    if (
      !this.options.auth.isPrincipal(credentials, 'user') ||
      credentials.principal.userEntityRef === 'user:default/guest'
    )
      throw new NotAllowedError(
        'Cloud requests require a mapped non-guest user',
      );
    const ref = credentials.principal.userEntityRef;
    const info = await this.options.userInfo.getUserInfo(credentials);
    const entity = await this.options.catalog.getEntityByRef(ref, {
      credentials,
    });
    if (!entity || entity.kind !== 'User')
      throw new NotAllowedError('Cloud user is not mapped in the catalog');
    // Require both authenticated ownership claims and current catalog relations.
    const memberships = (entity.relations ?? [])
      .filter(r => r.type === 'memberOf')
      .map(r => r.targetRef);
    return {
      ref,
      groups: info.ownershipEntityRefs.filter(group =>
        memberships.includes(group),
      ),
    };
  }

  private async groupExists(
    credentials: BackstageCredentials,
    includeApplicationGroup = false,
  ) {
    const groups = includeApplicationGroup
      ? applicationReviewerGroups
      : [this.configuredTarget.owner];
    for (const ref of groups) {
      const group = await this.options.catalog.getEntityByRef(ref, {
        credentials,
      });
      if (!group || group.kind !== 'Group')
        throw new NotAllowedError('Cloud reviewer group is not configured');
    }
  }
  private async requireApplicationOwnership(credentials: BackstageCredentials) {
    for (const ref of [
      'system:default/rizz-ai',
      'component:default/rizz-frontend',
      'component:default/rizz-backend',
      'api:default/rizz-api',
    ]) {
      const entity = await this.options.catalog.getEntityByRef(ref, {
        credentials,
      });
      if (!entity || entity.spec?.owner !== applicationReviewerGroups[0])
        throw new ConflictError('Rizz.AI catalog ownership missing or changed');
    }
  }
  private async requireTemplate(credentials: BackstageCredentials) {
    const entity = await this.options.catalog.getEntityByRef(
      'template:default/deploy-rizz-ai',
      { credentials },
    );
    if (!cloudTemplateMatches(entity))
      throw new ConflictError('Cloud template missing or changed');
  }
  async capabilities(credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    const canSubmit = viewer.groups.some(group =>
      this.options.configuration.submitterGroups.includes(group),
    );
    return {
      state: 'configured' as const,
      canSubmit,
      canRetire: Boolean(
        this.options.configuration.delivery?.observeApplication &&
          this.options.configuration.readers.readRetirementCleanup &&
          this.options.configuration.readers.readRetiredAppCleanup &&
          this.options.configuration.readers.readPullRequest &&
          this.options.configuration.readers.isAncestor &&
          this.options.configuration.readers.readGitopsRevision,
      ),
      reviewPolicy: {
        reviewerGroups: [...applicationReviewerGroups],
        memberOfReviewerGroup: applicationReviewerGroups.some(group =>
          viewer.groups.includes(group),
        ),
        distinctReviewerRequired: true as const,
      },
      target: {
        id: this.configuredTarget.id,
        clusterName: this.configuredTarget.clusterName,
        namespace: this.configuredTarget.namespace,
        owner: this.configuredTarget.owner,
        region: this.configuredTarget.region,
      },
      exposure: 'restricted_alb_https' as const,
      readiness:
        'Not checked. Submission verifies live target and release evidence.',
    };
  }

  private async current() {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Readers must honor cancellation. The service also bounds its response
      // even if an adapter accidentally fails to honor the signal.
      return await Promise.race([
        (async () => {
          const observed = await this.options.configuration.readers.readGitops(
            this.target,
            controller.signal,
          );
          const currentState = currentCloudStateSchema.parse(
            observed.currentState,
          );
          await this.options.configuration.readers.verifyTarget(
            this.target,
            controller.signal,
            currentState.state === 'absent' ? 'initial' : 'deployed',
          );
          return {
            base: observed.base,
            currentState,
            contents: observed.contents,
          };
        })(),
        new Promise<never>((_, reject) => {
          // The initial check makes sequential, separately bounded AWS CLI
          // reads for EKS, ACM, ALB, and security groups after GitOps reads.
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Cloud evidence timeout'));
          }, 60000);
        }),
      ]);
    } catch {
      throw new ServiceUnavailableError(
        'Cloud target or GitOps evidence unavailable',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async previewRuntime(input: unknown, credentials: BackstageCredentials) {
    await this.viewer(credentials);
    return (await this.forRequest()).previewRuntimeReady(input, credentials);
  }

  private async previewRuntimeReady(
    input: unknown,
    credentials: BackstageCredentials,
  ) {
    const viewer = await this.viewer(credentials);
    if (
      !viewer.groups.some(group =>
        this.options.configuration.submitterGroups.includes(group),
      )
    )
      throw new NotAllowedError('User is not authorized for the EKS target');
    const parsed = cloudRuntimeChangeInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid runtime change request');
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    const current = await this.current();
    if (current.currentState.state !== 'present' || !current.contents)
      throw new ConflictError('Existing complete GitOps deployment required');
    let preview: ReturnType<typeof previewCloudRuntimeChange>;
    try {
      preview = previewCloudRuntimeChange({
        input: parsed.data,
        target: this.target,
        base: current.base,
        contents: current.contents,
      });
    } catch {
      throw new ConflictError('Runtime baseline cannot be safely previewed');
    }
    if (JSON.stringify(preview.before) !== JSON.stringify(current.currentState))
      throw new ConflictError('Runtime reader evidence is inconsistent');
    return {
      state: preview.changedFields.length ? 'preview' : 'no_change',
      operation: 'runtime_change' as const,
      targetId: this.target.id,
      baseRevision: preview.base.revision,
      before: preview.before,
      after: preview.after,
      changedFields: preview.changedFields,
      changedFiles: preview.files
        .filter(file =>
          preview.changedFields.some(field =>
            file.path.endsWith(
              `/${
                field === 'frontendReplicas' ? 'frontend' : 'backend'
              }-deployment.yaml`,
            ),
          ),
        )
        .map(file => ({ path: file.path, sha256: file.sha256 })),
      observedAt: new Date().toISOString(),
      note: 'Read-only candidate. No proposal, approval or PR was created.',
    };
  }

  async submit(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
  ): Promise<CloudProposalView> {
    if (!this.resolvedTarget) {
      await this.viewer(credentials);
      return (await this.forRequest()).submit(input, credentials, channel);
    }
    const viewer = await this.viewer(credentials);
    if (
      !viewer.groups.some(g =>
        this.options.configuration.submitterGroups.includes(g),
      )
    )
      throw new NotAllowedError('User is not authorized for the EKS target');
    const parsed = cloudProposalInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid cloud release request');
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    const release = await this.options.configuration.releases.resolve(
      parsed.data.inputs.releaseId,
      parsed.data.inputs.releaseRecordDigest,
    );
    if (release.state !== 'verified')
      throw new ConflictError(`Release unavailable: ${release.reason}`);
    const current = await this.current();
    const id = randomUUID();
    const snapshot = createCloudFrozenSnapshot({
      proposal: parsed.data,
      target: this.target,
      release,
      context: {
        proposalId: id,
        requester: viewer.ref,
        submissionChannel: channel,
      },
      gitopsBase: current.base,
    });
    if (
      current.currentState.state === 'retiring' ||
      current.currentState.state === 'retired'
    )
      throw new ConflictError('Rizz.AI retirement is in progress');
    if (
      (snapshot.envelope.gitopsBase.files.length === 0) !==
      (current.currentState.state === 'absent')
    )
      throw new ConflictError('Current configuration and GitOps base disagree');
    const semantic = await this.options.jev.evaluateCloud(
      snapshot,
      current.currentState,
    );
    const review = decideReview({
      semantic,
      owner: this.target.owner,
      ownershipEntityRefs: viewer.groups,
    });
    if (review.status === 'pending_approval')
      review.reasonCodes = [
        'staging_write_requires_human_review',
        'distinct_app_or_platform_reviewer_required',
      ];
    const at = new Date().toISOString();
    const record: CloudProposalRecord = {
      id,
      version: 1,
      requester: viewer.ref,
      status: cloudStatusSchema.parse(review.status),
      reasonCodes: review.reasonCodes,
      semantic,
      snapshot,
      currentState: current.currentState,
      createdAt: at,
      audit: [
        { event: 'submitted', actor: viewer.ref, at, digest: snapshot.digest },
      ],
    };
    await this.client('rizz_cloud_proposals').insert({
      id,
      version: record.version,
      requester: viewer.ref,
      status: record.status,
      record: JSON.stringify(record),
      created_at: at,
    });
    this.options.logger.info('Cloud release proposal submitted', {
      proposalId: id,
      status: record.status,
    });
    return this.view(record, viewer);
  }

  async submitRuntime(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
  ): Promise<CloudProposalView> {
    if (!this.resolvedTarget) {
      await this.viewer(credentials);
      return (await this.forRequest()).submitRuntime(
        input,
        credentials,
        channel,
      );
    }
    const viewer = await this.viewer(credentials);
    if (
      !viewer.groups.some(group =>
        this.options.configuration.submitterGroups.includes(group),
      )
    )
      throw new NotAllowedError('User is not authorized for the EKS target');
    const parsed = cloudRuntimeChangeInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid runtime change request');
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    const current = await this.current();
    if (current.currentState.state !== 'present' || !current.contents)
      throw new ConflictError('Existing complete GitOps deployment required');
    const id = randomUUID();
    let snapshot: CloudRuntimeSnapshot;
    try {
      snapshot = createCloudRuntimeSnapshot({
        input: parsed.data,
        context: {
          proposalId: id,
          requester: viewer.ref,
          submissionChannel: channel,
        },
        target: this.target,
        gitopsBase: current.base,
        contents: current.contents,
      });
    } catch {
      throw new ConflictError('Runtime baseline changed, invalid or no-op');
    }
    if (
      JSON.stringify(snapshot.envelope.before) !==
      JSON.stringify(current.currentState)
    )
      throw new ConflictError('Runtime reader evidence is inconsistent');
    const semantic = await this.options.jev.evaluateRuntimeChange(snapshot);
    const review = decideReview({
      semantic,
      owner: this.target.owner,
      ownershipEntityRefs: viewer.groups,
    });
    if (review.status === 'pending_approval')
      review.reasonCodes = [
        'staging_write_requires_human_review',
        'distinct_app_or_platform_reviewer_required',
      ];
    const at = new Date().toISOString();
    const record: CloudProposalRecord = {
      id,
      version: 1,
      requester: viewer.ref,
      status: cloudStatusSchema.parse(review.status),
      reasonCodes: review.reasonCodes,
      semantic,
      snapshot,
      currentState: current.currentState,
      createdAt: at,
      audit: [
        { event: 'submitted', actor: viewer.ref, at, digest: snapshot.digest },
      ],
    };
    await this.client('rizz_cloud_proposals').insert({
      id,
      version: record.version,
      requester: viewer.ref,
      status: record.status,
      record: JSON.stringify(record),
      created_at: at,
    });
    this.options.logger.info('Cloud runtime change proposal submitted', {
      proposalId: id,
      status: record.status,
    });
    return this.view(record, viewer);
  }

  private async storedVerifiedDeployment(id: string) {
    if (!z.string().uuid().safeParse(id).success)
      throw new InputError('Invalid verified deployment ID');
    const row = await this.client('rizz_verified_deployments')
      .where({ proposal_id: id })
      .first();
    if (!row) throw new ConflictError('Verified deployment not found');
    return JSON.parse(row.record) as CloudVerifiedDeployment;
  }

  private async prepareRollback(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
    id: string,
  ) {
    const viewer = await this.viewer(credentials);
    if (
      !viewer.groups.some(group =>
        this.options.configuration.submitterGroups.includes(group),
      )
    )
      throw new NotAllowedError('User is not authorized for the EKS target');
    const parsed = cloudRollbackInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid rollback request');
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    const candidate = await this.storedVerifiedDeployment(
      parsed.data.verifiedDeploymentId,
    );
    if (
      candidate.operation !== 'rizz_cloud_release' ||
      candidate.snapshot.envelope.kind !== 'rizz_cloud_release' ||
      !cloudSnapshotHasIntegrity(candidate.snapshot) ||
      candidate.snapshotDigest !== candidate.snapshot.digest ||
      candidate.proposalId !== candidate.snapshot.envelope.proposalId ||
      canonicalize(candidate.snapshot.envelope.target) !==
        canonicalize(this.target) ||
      candidate.sourceRelease?.releaseId !==
        candidate.snapshot.envelope.inputs.releaseId ||
      candidate.sourceRelease.recordDigest !==
        candidate.snapshot.envelope.release.recordDigest
    )
      throw new ConflictError('Rollback history is incompatible or invalid');
    const release = await this.options.configuration.releases.resolve(
      candidate.sourceRelease.releaseId,
      candidate.sourceRelease.recordDigest,
    );
    if (release.state !== 'verified')
      throw new ConflictError(
        `Rollback release unavailable: ${release.reason}`,
      );
    const current = await this.current();
    if (current.currentState.state !== 'present' || !current.contents)
      throw new ConflictError('Existing complete GitOps deployment required');
    const snapshot = createCloudFrozenSnapshot({
      proposal: {
        declaredIntent: parsed.data.declaredIntent,
        templateId: 'deploy-rizz-ai',
        inputs: {
          targetId: this.target.id,
          releaseId: candidate.sourceRelease.releaseId,
          releaseRecordDigest: candidate.sourceRelease.recordDigest,
          frontendReplicas: candidate.frontendReplicas,
          backendReplicas: candidate.backendReplicas,
        },
      },
      target: this.target,
      release,
      context: {
        proposalId: id,
        requester: viewer.ref,
        submissionChannel: channel,
      },
      gitopsBase: current.base,
      rollbackSource: {
        verifiedDeploymentId: candidate.proposalId,
        snapshotDigest: candidate.snapshotDigest,
        mergeRevision: candidate.mergeRevision,
        verifiedAt: candidate.verifiedAt,
      },
    });
    if (
      snapshot.files.length !== candidate.snapshot.files.length ||
      snapshot.files.some(
        (file, index) =>
          file.path !== candidate.snapshot.files[index].path ||
          file.sha256 !== candidate.snapshot.files[index].sha256,
      ) ||
      canonicalize(
        JSON.parse(
          JSON.stringify(
            inspectCloudGitopsFiles(current.contents, this.target),
          ),
        ),
      ) !== canonicalize(JSON.parse(JSON.stringify(current.currentState))) ||
      !rollbackPreservesProtectedConfiguration({
        current: current.contents,
        restored: snapshot.files,
        gitopsPath: this.target.gitopsPath,
      }) ||
      snapshot.files.every(
        file =>
          current.contents![
            file.path.slice(this.target.gitopsPath.length + 1)
          ] === file.content,
      )
    )
      throw new ConflictError(
        'Rollback recipe, protected configuration or current state is incompatible',
      );
    return { viewer, candidate, current, snapshot };
  }

  async previewRollback(input: unknown, credentials: BackstageCredentials) {
    await this.viewer(credentials);
    return (await this.forRequest()).previewRollbackReady(input, credentials);
  }

  private async previewRollbackReady(
    input: unknown,
    credentials: BackstageCredentials,
  ) {
    const { candidate, current, snapshot } = await this.prepareRollback(
      input,
      credentials,
      'backstage_rest',
      randomUUID(),
    );
    return {
      state: 'preview' as const,
      operation: 'rollback' as const,
      targetId: this.target.id,
      verifiedDeploymentId: candidate.proposalId,
      verifiedAt: candidate.verifiedAt,
      baseRevision: snapshot.envelope.gitopsBase.revision,
      before: current.currentState,
      after: {
        frontendImage: candidate.frontendImage,
        backendImage: candidate.backendImage,
        frontendReplicas: candidate.frontendReplicas,
        backendReplicas: candidate.backendReplicas,
      },
      changedFiles: snapshot.files
        .filter(
          file =>
            file.content !==
            current.contents![
              file.path.slice(this.target.gitopsPath.length + 1)
            ],
        )
        .map(file => ({ path: file.path, sha256: file.sha256 })),
      observedAt: new Date().toISOString(),
      note: 'Read-only candidate. No proposal, approval or PR was created.',
    };
  }

  async submitRollback(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
  ): Promise<CloudProposalView> {
    if (!this.resolvedTarget) {
      await this.viewer(credentials);
      return (await this.forRequest()).submitRollback(
        input,
        credentials,
        channel,
      );
    }
    const id = randomUUID();
    const { viewer, current, snapshot } = await this.prepareRollback(
      input,
      credentials,
      channel,
      id,
    );
    const semantic = await this.options.jev.evaluateCloud(
      snapshot,
      current.currentState,
    );
    const review = decideReview({
      semantic,
      owner: this.target.owner,
      ownershipEntityRefs: viewer.groups,
    });
    if (review.status === 'pending_approval')
      review.reasonCodes = [
        'rollback_requires_human_review',
        'distinct_app_or_platform_reviewer_required',
      ];
    const at = new Date().toISOString();
    const record: CloudProposalRecord = {
      id,
      version: 1,
      requester: viewer.ref,
      status: cloudStatusSchema.parse(review.status),
      reasonCodes: review.reasonCodes,
      semantic,
      snapshot,
      currentState: current.currentState,
      createdAt: at,
      audit: [
        { event: 'submitted', actor: viewer.ref, at, digest: snapshot.digest },
      ],
    };
    await this.client('rizz_cloud_proposals').insert({
      id,
      version: record.version,
      requester: viewer.ref,
      status: record.status,
      record: JSON.stringify(record),
      created_at: at,
    });
    return this.view(record, viewer);
  }

  private async prepareRetirement(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
    id: string,
  ) {
    const viewer = await this.viewer(credentials);
    if (
      !viewer.groups.some(group =>
        this.options.configuration.submitterGroups.includes(group),
      )
    )
      throw new NotAllowedError('User is not authorized for the EKS target');
    const parsed = retirementInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid retirement request');
    await this.groupExists(credentials, true);
    await this.requireApplicationOwnership(credentials);
    await this.requireTemplate(credentials);
    if (
      !this.options.configuration.delivery?.observeApplication ||
      !this.options.configuration.readers.readRetirementCleanup ||
      !this.options.configuration.readers.readRetiredAppCleanup ||
      !this.options.configuration.readers.readPullRequest ||
      !this.options.configuration.readers.isAncestor ||
      !this.options.configuration.readers.readGitopsRevision
    )
      throw new ServiceUnavailableError(
        'Retirement observation is unavailable',
      );
    const signal = AbortSignal.timeout(30000);
    let current: Awaited<ReturnType<CloudReaders['readGitops']>>;
    try {
      current = await this.options.configuration.readers.readGitops(
        this.target,
        signal,
      );
    } catch {
      throw new ServiceUnavailableError('GitOps evidence unavailable');
    }
    const state = currentCloudStateSchema.parse(current.currentState);
    if (!current.contents || !['present', 'retiring'].includes(state.state))
      throw new ConflictError('No supported active application to retire');
    let cleanupEvidence:
      | Awaited<ReturnType<NonNullable<CloudReaders['readRetirementCleanup']>>>
      | undefined;
    try {
      if (state.state === 'present')
        await this.options.configuration.readers.verifyTarget(
          this.target,
          signal,
        );
      else
        cleanupEvidence =
          await this.options.configuration.readers.readRetirementCleanup(
            this.target,
            signal,
          );
    } catch {
      throw new ServiceUnavailableError(
        'Retirement target or cleanup evidence unavailable',
      );
    }
    if (state.state === 'retiring')
      await this.requireApprovedIngressRemoval(
        current.base,
        current.contents,
        signal,
      );
    let snapshot: CloudRetirementSnapshot;
    try {
      snapshot = createCloudRetirementSnapshot({
        input: parsed.data,
        context: {
          proposalId: id,
          requester: viewer.ref,
          submissionChannel: channel,
        },
        target: this.target,
        gitopsBase: current.base,
        contents: current.contents,
        cleanupEvidence,
      });
    } catch {
      throw new ConflictError('Retirement baseline is unsupported or changed');
    }
    return { viewer, snapshot, state };
  }

  private async requireApprovedIngressRemoval(
    rawBase: unknown,
    contents: Record<string, string>,
    signal: AbortSignal,
  ) {
    const base = cloudGitopsBaseSchema.parse(rawBase);
    const readers = this.options.configuration.readers;
    if (!readers.readPullRequest || !readers.isAncestor)
      throw new ServiceUnavailableError(
        'Retirement PR verification unavailable',
      );
    const rows = await this.client('rizz_cloud_proposals')
      .where({ status: 'pr_open' })
      .orderBy('created_at', 'desc')
      .limit(200);
    const repo = this.target.gitopsRepository
      .slice('https://github.com/'.length)
      .replace(/\.git$/, '');
    for (const row of rows) {
      const candidate = JSON.parse(row.record) as CloudProposalRecord;
      if (
        candidate.snapshot.envelope.kind !== 'rizz_cloud_retire_ingress' ||
        !cloudRetirementSnapshotHasIntegrity(candidate.snapshot) ||
        candidate.decision?.decision !== 'approve' ||
        candidate.decision.digest !== candidate.snapshot.digest ||
        candidate.decision.reviewer === candidate.requester ||
        !candidate.execution?.prNumber ||
        candidate.snapshot.files.some(
          file =>
            contents[file.path.slice(this.target.gitopsPath.length + 1)] !==
            file.content,
        )
      )
        continue;
      const pull = z
        .object({
          number: z.literal(candidate.execution.prNumber),
          state: z.literal('closed'),
          merged_at: z.string().datetime(),
          merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
          base: z.object({
            ref: z.literal('main'),
            repo: z.object({ full_name: z.literal(repo) }),
          }),
          head: z.object({
            ref: z.literal(`agent-guard-cloud/${candidate.id}`),
            repo: z.object({ full_name: z.literal(repo) }),
          }),
        })
        .safeParse(
          await readers.readPullRequest(
            this.target,
            candidate.execution.prNumber,
            signal,
          ),
        );
      if (
        pull.success &&
        (await readers.isAncestor(
          this.target,
          pull.data.merge_commit_sha,
          base.revision,
          signal,
        ))
      ) {
        if (
          !this.options.configuration.delivery?.observeApplication ||
          !readers.readGitopsRevision
        )
          throw new ServiceUnavailableError(
            'Argo retirement evidence unavailable',
          );
        const argo =
          await this.options.configuration.delivery.observeApplication(
            this.target,
            signal,
          );
        if (
          argo.sync !== 'Synced' ||
          argo.health !== 'Healthy' ||
          !(await readers.isAncestor(
            this.target,
            pull.data.merge_commit_sha,
            argo.revision,
            signal,
          ))
        )
          continue;
        const synced = await readers.readGitopsRevision(
          this.target,
          argo.revision,
          signal,
        );
        if (
          synced.contents &&
          candidate.snapshot.files.every(
            file =>
              synced.contents![
                file.path.slice(this.target.gitopsPath.length + 1)
              ] === file.content,
          ) &&
          candidate.snapshot.deletePaths.every(
            path =>
              !(
                path.slice(this.target.gitopsPath.length + 1) in
                synced.contents!
              ),
          )
        )
          return;
      }
    }
    throw new ConflictError(
      'An approved merged ingress-removal PR is required before app cleanup',
    );
  }

  async previewRetirement(input: unknown, credentials: BackstageCredentials) {
    await this.viewer(credentials);
    return (await this.forRequest()).previewRetirementReady(input, credentials);
  }

  private async previewRetirementReady(
    input: unknown,
    credentials: BackstageCredentials,
  ) {
    const { snapshot, state } = await this.prepareRetirement(
      input,
      credentials,
      'backstage_rest',
      randomUUID(),
    );
    return {
      state: 'preview' as const,
      operation: 'retire' as const,
      stage: snapshot.envelope.kind,
      targetId: this.target.id,
      before: state,
      baseRevision: snapshot.envelope.gitopsBase.revision,
      changedFiles: snapshot.envelope.generatedFiles,
      deletedPaths: snapshot.deletePaths,
      cleanupEvidence: snapshot.envelope.cleanupEvidence,
      retainedFoundation: [
        'EKS cluster',
        'VPC',
        'ECR repositories and images',
        'Terraform state',
        'AWS runtime secret',
      ],
      observedAt: new Date().toISOString(),
      note: 'Read-only preview. No proposal, approval or PR was created.',
    };
  }

  async submitRetirement(
    input: unknown,
    credentials: BackstageCredentials,
    channel: SubmissionChannel,
  ): Promise<CloudProposalView> {
    if (!this.resolvedTarget) {
      await this.viewer(credentials);
      return (await this.forRequest()).submitRetirement(
        input,
        credentials,
        channel,
      );
    }
    const id = randomUUID();
    const { viewer, snapshot, state } = await this.prepareRetirement(
      input,
      credentials,
      channel,
      id,
    );
    const semantic = await this.options.jev.evaluateRetirement(snapshot);
    const review = decideReview({
      semantic,
      owner: this.target.owner,
      ownershipEntityRefs: viewer.groups,
    });
    if (review.status === 'pending_approval')
      review.reasonCodes = [
        'destructive_app_retirement_requires_platform_review',
        'distinct_platform_reviewer_required',
      ];
    const at = new Date().toISOString();
    const record: CloudProposalRecord = {
      id,
      version: 1,
      requester: viewer.ref,
      status: cloudStatusSchema.parse(review.status),
      reasonCodes: review.reasonCodes,
      semantic,
      snapshot,
      currentState: state,
      createdAt: at,
      audit: [
        { event: 'submitted', actor: viewer.ref, at, digest: snapshot.digest },
      ],
    };
    await this.client('rizz_cloud_proposals').insert({
      id,
      version: record.version,
      requester: viewer.ref,
      status: record.status,
      record: JSON.stringify(record),
      created_at: at,
    });
    this.options.logger.info('Cloud retirement proposal submitted', {
      proposalId: id,
      stage: snapshot.envelope.kind,
      status: record.status,
    });
    return this.view(record, viewer);
  }

  private async stored(id: string): Promise<CloudProposalRecord> {
    if (!z.string().uuid().safeParse(id).success)
      throw new InputError('Invalid proposal ID');
    const row = await this.client('rizz_cloud_proposals').where({ id }).first();
    if (!row) throw new NotFoundError('Cloud proposal not found');
    return JSON.parse(row.record);
  }
  private visible(record: CloudProposalRecord, viewer: Viewer) {
    return (
      record.requester === viewer.ref ||
      this.reviewerGroups(record).some(group => viewer.groups.includes(group))
    );
  }
  private reviewerGroups(record: CloudProposalRecord) {
    return reviewerGroupsForPolicy(record.snapshot.envelope.policyVersion);
  }
  private reviewable(record: CloudProposalRecord, viewer: Viewer) {
    return (
      record.status === 'pending_approval' &&
      record.requester !== viewer.ref &&
      this.reviewerGroups(record).some(group =>
        viewer.groups.includes(group),
      ) &&
      this.hasIntegrity(record.snapshot)
    );
  }
  private hasIntegrity(snapshot: CloudProposalRecord['snapshot']) {
    if (
      snapshot.envelope.kind === 'rizz_cloud_retire_ingress' ||
      snapshot.envelope.kind === 'rizz_cloud_retire_app'
    )
      return cloudRetirementSnapshotHasIntegrity(snapshot);
    return snapshot.envelope.kind === 'rizz_cloud_runtime_change'
      ? cloudRuntimeSnapshotHasIntegrity(snapshot)
      : cloudSnapshotHasIntegrity(snapshot);
  }
  private view(record: CloudProposalRecord, viewer: Viewer): CloudProposalView {
    const { execution, ...rest } = record;
    const safe = execution
      ? (({ claimHash: _claim, ...publicFields }) => publicFields)(execution)
      : undefined;
    return {
      ...rest,
      ...(safe ? { execution: safe } : {}),
      viewerPermissions: { canReview: this.reviewable(record, viewer) },
    };
  }
  async get(id: string, credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    const record = await this.stored(id);
    if (!this.visible(record, viewer))
      throw new NotAllowedError('Cloud proposal is not visible to this user');
    return this.view(record, viewer);
  }
  async observeDelivery(id: string, credentials: BackstageCredentials) {
    // Scope authorization precedes any provider read. Never change proposal,
    // task, approval or audit state merely because someone refreshes the UI.
    const proposal = await this.get(id, credentials);
    if (
      proposal.snapshot.envelope.kind === 'rizz_cloud_retire_ingress' ||
      proposal.snapshot.envelope.kind === 'rizz_cloud_retire_app'
    )
      return emptyCloudDelivery();
    const observed = this.options.configuration.delivery
      ? this.options.configuration.delivery.observe(proposal)
      : emptyCloudDelivery();
    const result = await observed;
    const verified = verifiedCloudDeployment(proposal, result);
    if (verified)
      await this.client('rizz_verified_deployments')
        .insert({
          proposal_id: verified.proposalId,
          verified_at: verified.verifiedAt,
          record: JSON.stringify(verified),
        })
        .onConflict('proposal_id')
        .ignore();
    return result;
  }
  async observeRetirement(id: string, credentials: BackstageCredentials) {
    await this.viewer(credentials);
    return (await this.forRequest()).observeRetirementReady(id, credentials);
  }

  private async observeRetirementReady(
    id: string,
    credentials: BackstageCredentials,
  ) {
    const proposal = await this.get(id, credentials);
    const snapshot = proposal.snapshot;
    if (
      snapshot.envelope.kind !== 'rizz_cloud_retire_ingress' &&
      snapshot.envelope.kind !== 'rizz_cloud_retire_app'
    )
      throw new InputError('Not a retirement proposal');
    const checkedAt = new Date().toISOString();
    const stage = snapshot.envelope.kind;
    const result = (
      state:
        | 'waiting_for_pr'
        | 'waiting_for_merge'
        | 'waiting_for_gitops'
        | 'cleanup_not_verified'
        | 'complete'
        | 'unavailable',
      mainRevision?: string,
    ) => ({
      stage,
      state,
      complete: state === 'complete',
      checkedAt,
      prUrl: proposal.execution?.prUrl,
      ...(mainRevision ? { mainRevision } : {}),
    });
    if (
      !cloudRetirementSnapshotHasIntegrity(snapshot) ||
      proposal.decision?.decision !== 'approve' ||
      proposal.decision.digest !== snapshot.digest ||
      proposal.decision.reviewer === proposal.requester
    )
      return result('unavailable');
    if (!proposal.execution?.prNumber) return result('waiting_for_pr');
    const readers = this.options.configuration.readers;
    if (!readers.readPullRequest || !readers.isAncestor)
      return result('unavailable');
    const signal = AbortSignal.timeout(45000);
    try {
      const repo = this.target.gitopsRepository
        .slice('https://github.com/'.length)
        .replace(/\.git$/, '');
      const pull = z
        .object({
          number: z.literal(proposal.execution.prNumber),
          state: z.enum(['open', 'closed']),
          merged_at: z.string().datetime().nullable(),
          merge_commit_sha: z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .nullable(),
          base: z.object({
            ref: z.literal('main'),
            repo: z.object({ full_name: z.literal(repo) }),
          }),
          head: z.object({
            ref: z.literal(`agent-guard-cloud/${proposal.id}`),
            repo: z.object({ full_name: z.literal(repo) }),
          }),
        })
        .parse(
          await readers.readPullRequest(
            this.target,
            proposal.execution.prNumber,
            signal,
          ),
        );
      if (!pull.merged_at || !pull.merge_commit_sha)
        return result('waiting_for_merge');
      const current = await readers.readGitops(this.target, signal);
      const base = cloudGitopsBaseSchema.parse(current.base);
      const currentState = currentCloudStateSchema.safeParse(
        current.currentState,
      );
      if (
        !(await readers.isAncestor(
          this.target,
          pull.merge_commit_sha,
          base.revision,
          signal,
        )) ||
        !current.contents ||
        !currentState.success ||
        currentState.data.state !==
          (stage === 'rizz_cloud_retire_ingress' ? 'retiring' : 'retired') ||
        snapshot.files.some(
          file =>
            current.contents![
              file.path.slice(this.target.gitopsPath.length + 1)
            ] !== file.content,
        ) ||
        snapshot.deletePaths.some(
          path =>
            path.slice(this.target.gitopsPath.length + 1) in current.contents!,
        )
      )
        return result('waiting_for_gitops', base.revision);
      if (
        !this.options.configuration.delivery?.observeApplication ||
        !readers.readGitopsRevision
      )
        return result('unavailable', base.revision);
      const argo = await this.options.configuration.delivery.observeApplication(
        this.target,
        signal,
      );
      if (
        argo.sync !== 'Synced' ||
        argo.health !== 'Healthy' ||
        !(await readers.isAncestor(
          this.target,
          pull.merge_commit_sha,
          argo.revision,
          signal,
        ))
      )
        return result('waiting_for_gitops', base.revision);
      const synced = await readers.readGitopsRevision(
        this.target,
        argo.revision,
        signal,
      );
      if (
        !synced.contents ||
        snapshot.files.some(
          file =>
            synced.contents![
              file.path.slice(this.target.gitopsPath.length + 1)
            ] !== file.content,
        ) ||
        snapshot.deletePaths.some(
          path =>
            path.slice(this.target.gitopsPath.length + 1) in synced.contents!,
        )
      )
        return result('waiting_for_gitops', base.revision);
      try {
        if (stage === 'rizz_cloud_retire_ingress') {
          if (!readers.readRetirementCleanup) return result('unavailable');
          await readers.readRetirementCleanup(this.target, signal);
        } else {
          if (!readers.readRetiredAppCleanup) return result('unavailable');
          await readers.readRetiredAppCleanup(this.target, signal);
        }
      } catch {
        return result('cleanup_not_verified', base.revision);
      }
      const finalArgo =
        await this.options.configuration.delivery.observeApplication(
          this.target,
          signal,
        );
      if (
        finalArgo.revision !== argo.revision ||
        finalArgo.sync !== 'Synced' ||
        finalArgo.health !== 'Healthy'
      )
        return result('waiting_for_gitops', base.revision);
      return result('complete', base.revision);
    } catch {
      return result('unavailable');
    }
  }
  async listVerifiedDeployments(credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    if (!applicationReviewerGroups.some(group => viewer.groups.includes(group)))
      throw new NotAllowedError('Rizz.AI deployment history is role-scoped');
    const rows = await this.client('rizz_verified_deployments')
      .orderBy('verified_at', 'desc')
      .limit(50);
    return rows
      .map(row => JSON.parse(row.record) as CloudVerifiedDeployment)
      .filter(record =>
        record.snapshot.envelope.kind === 'rizz_cloud_runtime_change'
          ? cloudRuntimeSnapshotHasIntegrity(record.snapshot)
          : cloudSnapshotHasIntegrity(record.snapshot),
      )
      .map(verifiedDeploymentSummary);
  }
  async readiness(credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    if (!applicationReviewerGroups.some(group => viewer.groups.includes(group)))
      throw new NotAllowedError('Rizz.AI readiness is role-scoped');
    const checkedAt = new Date().toISOString();
    const refs = [
      'system:default/rizz-ai',
      'component:default/rizz-frontend',
      'component:default/rizz-backend',
      'api:default/rizz-api',
    ];
    const entities = await Promise.all(
      refs.map(ref =>
        this.options.catalog.getEntityByRef(ref, { credentials }),
      ),
    );
    const [system, frontend, backend, api] = entities;
    const owner = applicationReviewerGroups[0];
    const ownershipValid = entities.every(
      entity => entity?.spec?.owner === owner,
    );
    const relationshipsValid =
      frontend?.spec?.system === 'rizz-ai' &&
      backend?.spec?.system === 'rizz-ai' &&
      api?.spec?.system === 'rizz-ai' &&
      Array.isArray(frontend.spec.consumesApis) &&
      frontend.spec.consumesApis.includes('rizz-api') &&
      Array.isArray(backend.spec.providesApis) &&
      backend.spec.providesApis.includes('rizz-api');
    const sourceValid = [system, frontend, backend].every(
      entity =>
        typeof entity?.metadata.annotations?.[
          'backstage.io/source-location'
        ] === 'string',
    );
    const techdocsReference =
      typeof system?.metadata.annotations?.['backstage.io/techdocs-ref'] ===
      'string';
    const releases = await this.options.configuration.releases.list();
    let desiredRecipe:
      | 'verified'
      | 'absent'
      | 'retiring'
      | 'retired'
      | 'unavailable' = 'unavailable';
    let target: CloudTarget | undefined;
    try {
      target = (await this.forRequest()).target;
    } catch {
      // Cloud metadata is not available yet; independent catalog, release and
      // history checks can still be shown as unknown or current evidence.
    }
    try {
      if (!target) throw new Error('Cloud target unavailable');
      const desired = await this.options.configuration.readers.readGitops(
        target,
        AbortSignal.timeout(15000),
      );
      if (desired.contents) {
        const state = currentCloudStateSchema.parse(desired.currentState).state;
        desiredRecipe = state === 'present' ? 'verified' : state;
      }
    } catch {
      desiredRecipe = 'unavailable';
    }
    const releaseAvailable =
      releases.state === 'available' &&
      releases.items.some(
        item =>
          item.eligibleForProposal && Date.parse(item.expiresAt) > Date.now(),
      );
    const rows = await this.client('rizz_verified_deployments')
      .orderBy('verified_at', 'desc')
      .limit(50);
    const history = rows
      .map(row => JSON.parse(row.record) as CloudVerifiedDeployment)
      .filter(record =>
        record.snapshot.envelope.kind === 'rizz_cloud_runtime_change'
          ? cloudRuntimeSnapshotHasIntegrity(record.snapshot)
          : cloudSnapshotHasIntegrity(record.snapshot),
      );
    const candidate = history.find(
      record =>
        record.operation === 'rizz_cloud_release' && record.sourceRelease,
    );
    const retained = candidate?.sourceRelease
      ? await this.options.configuration.releases.resolve(
          candidate.sourceRelease.releaseId,
          candidate.sourceRelease.recordDigest,
        )
      : undefined;
    const metrics =
      this.options.configuration.metrics && target
        ? await this.options.configuration.metrics.observe(target)
        : { state: 'unavailable' as const };
    type State = 'pass' | 'fail' | 'unknown';
    const check = (
      id: string,
      title: string,
      state: State,
      detail: string,
      evidenceUrl: string,
    ) => ({ id, title, state, detail, evidenceUrl, checkedAt });
    let pairedReleaseState: State = 'unknown';
    let pairedReleaseDetail =
      'Trusted CI evidence is unavailable or not configured.';
    if (releases.state === 'available') {
      pairedReleaseState = releaseAvailable ? 'pass' : 'fail';
      pairedReleaseDetail = releaseAvailable
        ? 'At least one current paired release has verified CI and immutable image evidence.'
        : 'No eligible paired release is available.';
    }
    const desiredRecipeDetails = {
      verified:
        'The pinned GitOps files match the platform recipe, including both workloads’ health probes and CPU/memory requests and limits. This does not prove live rollout.',
      absent: 'No application GitOps configuration exists yet.',
      retiring:
        'Retirement has removed ingress from desired state; application workloads remain until the next reviewed stage.',
      retired:
        'The empty retirement marker is the current desired state; app probes and resource bounds are no longer applicable.',
      unavailable:
        'The desired GitOps recipe could not be read or differs from the supported recipe.',
    };
    let rollbackState: State = 'unknown';
    let rollbackDetail =
      'No previously healthy release deployment is recorded.';
    if (candidate) {
      rollbackState = retained?.state === 'verified' ? 'pass' : 'fail';
      rollbackDetail =
        retained?.state === 'verified'
          ? 'A recorded healthy release still resolves to its exact CI artifact and image pair.'
          : 'Recorded healthy release evidence is missing, expired or incompatible.';
    }
    return {
      checkedAt,
      scope: 'rizz-ai/eks-staging',
      checks: [
        check(
          'ownership',
          'Application ownership',
          ownershipValid ? 'pass' : 'fail',
          ownershipValid
            ? 'All four catalog entities are owned by rizz-team.'
            : 'Catalog ownership is missing or inconsistent.',
          '/catalog/default/system/rizz-ai',
        ),
        check(
          'relationships',
          'Application and API relationships',
          relationshipsValid ? 'pass' : 'fail',
          relationshipsValid
            ? 'Both components and API belong to the Rizz.AI system.'
            : 'Component/API relationships are missing or inconsistent.',
          '/catalog/default/system/rizz-ai',
        ),
        check(
          'source',
          'Source links',
          sourceValid ? 'pass' : 'fail',
          sourceValid
            ? 'System and both components declare source locations.'
            : 'One or more source locations are missing.',
          '/catalog/default/system/rizz-ai',
        ),
        check(
          'techdocs_reference',
          'TechDocs reference',
          techdocsReference ? 'pass' : 'fail',
          techdocsReference
            ? 'Catalog reference exists; publication and content are not verified here.'
            : 'System has no TechDocs reference.',
          '/catalog/default/system/rizz-ai/docs',
        ),
        check(
          'paired_release',
          'Verified paired release',
          pairedReleaseState,
          pairedReleaseDetail,
          '/rizz-releases',
        ),
        check(
          'desired_recipe',
          'Probes and resource bounds',
          desiredRecipe === 'verified' ? 'pass' : 'unknown',
          desiredRecipeDetails[desiredRecipe],
          '/rizz-deployments',
        ),
        check(
          'historical_delivery',
          'Verified delivery history',
          history.length ? 'pass' : 'unknown',
          history.length
            ? 'At least one deployment passed merge, Argo, workload and smoke verification; this does not prove current health.'
            : 'No independently verified deployment has been recorded.',
          '/rizz-deployments',
        ),
        check(
          'retained_rollback',
          'Retained rollback source',
          rollbackState,
          rollbackDetail,
          '/rizz-deployments#rollback-form',
        ),
        check(
          'live_metrics',
          'Live application metrics',
          metrics.state === 'observed' ? 'pass' : 'unknown',
          metrics.state === 'observed'
            ? 'A private Kubernetes Service proxy returned a bounded sample from one backend replica; this is not an application-wide aggregate.'
            : 'The private metrics source is unavailable; unknown is not zero.',
          '/catalog/default/system/rizz-ai',
        ),
      ],
    };
  }
  async metrics(credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    if (!applicationReviewerGroups.some(group => viewer.groups.includes(group)))
      throw new NotAllowedError('Rizz.AI metrics are role-scoped');
    if (!this.options.configuration.metrics)
      return {
        state: 'unavailable' as const,
        checkedAt: new Date().toISOString(),
      };
    try {
      const target = (await this.forRequest()).target;
      return await this.options.configuration.metrics.observe(target);
    } catch {
      return {
        state: 'unavailable' as const,
        checkedAt: new Date().toISOString(),
      };
    }
  }
  async list(credentials: BackstageCredentials) {
    const viewer = await this.viewer(credentials);
    const rows = await this.client('rizz_cloud_proposals')
      .orderBy('created_at', 'desc')
      .limit(200);
    return rows
      .map(row => JSON.parse(row.record) as CloudProposalRecord)
      .filter(record => this.visible(record, viewer))
      .map(record => this.view(record, viewer));
  }
  private async replace(old: CloudProposalRecord, next: CloudProposalRecord) {
    next.version = old.version + 1;
    if (old.execution?.state !== next.execution?.state && next.execution) {
      next.audit = [
        ...next.audit,
        {
          event: `execution_${next.execution.state}`,
          actor: 'service:agent-guard',
          at: new Date().toISOString(),
          digest: next.snapshot.digest,
        },
      ];
    }
    const changed = await this.client('rizz_cloud_proposals')
      .where({ id: old.id, version: old.version, status: old.status })
      .update({
        version: next.version,
        status: next.status,
        record: JSON.stringify(next),
      });
    if (changed !== 1)
      throw new ConflictError('Cloud proposal state changed concurrently');
    return next;
  }
  private async recheck(record: CloudProposalRecord) {
    await this.requireTemplate(
      await this.options.auth.getOwnServiceCredentials(),
    );
    if (record.snapshot.envelope.policyVersion === applicationReviewPolicy)
      await this.requireApplicationOwnership(
        await this.options.auth.getOwnServiceCredentials(),
      );
    if (
      !this.hasIntegrity(record.snapshot) ||
      record.snapshot.envelope.requester !== record.requester ||
      record.snapshot.envelope.proposalId !== record.id
    )
      throw new ConflictError('Cloud snapshot integrity failed');
    if (
      record.snapshot.envelope.kind === 'rizz_cloud_retire_ingress' ||
      record.snapshot.envelope.kind === 'rizz_cloud_retire_app'
    ) {
      const snapshot = record.snapshot as CloudRetirementSnapshot;
      const signal = AbortSignal.timeout(30000);
      let current: Awaited<ReturnType<CloudReaders['readGitops']>>;
      try {
        current = await this.options.configuration.readers.readGitops(
          this.target,
          signal,
        );
        if (snapshot.envelope.kind === 'rizz_cloud_retire_ingress')
          await this.options.configuration.readers.verifyTarget(
            this.target,
            signal,
          );
        else {
          if (!this.options.configuration.readers.readRetirementCleanup)
            throw new Error('Cleanup reader missing');
          await this.options.configuration.readers.readRetirementCleanup(
            this.target,
            signal,
          );
          if (!current.contents)
            throw new Error('Retirement files unavailable');
          await this.requireApprovedIngressRemoval(
            current.base,
            current.contents,
            signal,
          );
        }
      } catch {
        throw new ServiceUnavailableError(
          'Retirement target or cleanup evidence unavailable',
        );
      }
      const currentBase = cloudGitopsBaseSchema.safeParse(current.base);
      const currentState = currentCloudStateSchema.safeParse(
        current.currentState,
      );
      if (
        !currentBase.success ||
        !currentState.success ||
        canonicalize(this.target) !== canonicalize(snapshot.envelope.target) ||
        canonicalize(currentBase.data) !==
          canonicalize(snapshot.envelope.gitopsBase) ||
        !current.contents ||
        currentState.data.state !==
          (snapshot.envelope.kind === 'rizz_cloud_retire_ingress'
            ? 'present'
            : 'retiring') ||
        snapshot.beforeFiles.some(
          file =>
            current.contents![
              file.path.slice(this.target.gitopsPath.length + 1)
            ] !== file.content,
        )
      )
        throw new ConflictError('Retirement preconditions changed');
      return;
    }
    const current = await this.current();
    const checked =
      record.snapshot.envelope.kind === 'rizz_cloud_runtime_change'
        ? revalidateCloudRuntimeSnapshot(record.snapshot, {
            target: this.target,
            gitopsBase: current.base,
            contents: current.contents,
          })
        : await revalidateCloudSnapshot(record.snapshot, {
            releases: this.options.configuration.releases,
            target: this.target,
            gitopsBase: current.base,
          });
    if (!checked.valid)
      throw new ConflictError(`Cloud preconditions changed: ${checked.reason}`);
    if (record.snapshot.envelope.kind === 'rizz_cloud_rollback') {
      const source = record.snapshot.envelope.rollbackSource!;
      const candidate = await this.storedVerifiedDeployment(
        source.verifiedDeploymentId,
      );
      if (
        candidate.operation !== 'rizz_cloud_release' ||
        !cloudSnapshotHasIntegrity(candidate.snapshot) ||
        candidate.snapshotDigest !== source.snapshotDigest ||
        candidate.mergeRevision !== source.mergeRevision ||
        candidate.verifiedAt !== source.verifiedAt ||
        candidate.snapshot.envelope.kind !== 'rizz_cloud_release' ||
        candidate.snapshot.files.length !== record.snapshot.files.length ||
        candidate.snapshot.files.some(
          (file, index) =>
            file.path !== record.snapshot.files[index].path ||
            file.sha256 !== record.snapshot.files[index].sha256,
        ) ||
        !current.contents ||
        !rollbackPreservesProtectedConfiguration({
          current: current.contents,
          restored: record.snapshot.files,
          gitopsPath: this.target.gitopsPath,
        })
      )
        throw new ConflictError(
          'Rollback history or protected configuration changed',
        );
    }
  }
  async decide(
    id: string,
    input: unknown,
    credentials: BackstageCredentials,
  ): Promise<CloudProposalView> {
    const viewer = await this.viewer(credentials);
    const record = await this.stored(id);
    if (!this.visible(record, viewer))
      throw new NotAllowedError('Cloud proposal is not visible');
    const parsed = proposalDecisionSchema.safeParse(input);
    if (!parsed.success) throw new InputError('Invalid cloud decision');
    if (!this.reviewable(record, viewer))
      throw new NotAllowedError(
        'Distinct authorized reviewer required by the frozen policy',
      );
    if (parsed.data.digest !== record.snapshot.digest)
      throw new ConflictError('Cloud approval digest changed');
    if (parsed.data.decision === 'approve' && !this.resolvedTarget)
      return (await this.forRequest()).decide(id, input, credentials);
    await this.groupExists(
      credentials,
      this.reviewerGroups(record).includes(applicationReviewerGroups[0]),
    );
    // Rejection can always close a pending request without cloud access.
    if (parsed.data.decision === 'approve') await this.recheck(record);
    const at = new Date().toISOString();
    const updated = await this.replace(record, {
      ...record,
      status: parsed.data.decision === 'approve' ? 'approved' : 'rejected',
      decision: {
        decision: parsed.data.decision,
        reviewer: viewer.ref,
        digest: record.snapshot.digest,
        at,
        ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
      },
      audit: [
        ...record.audit,
        {
          event: parsed.data.decision,
          actor: viewer.ref,
          at,
          digest: record.snapshot.digest,
        },
      ],
    });
    return this.view(
      updated.status === 'approved' ? await this.dispatch(updated) : updated,
      viewer,
    );
  }
  private async reviewerStillAuthorized(record: CloudProposalRecord) {
    if (
      record.decision?.decision !== 'approve' ||
      record.decision.reviewer === record.requester ||
      record.decision.digest !== record.snapshot.digest
    )
      throw new ConflictError('No exact distinct approval');
    const credentials = await this.options.auth.getOwnServiceCredentials();
    await this.groupExists(
      credentials,
      this.reviewerGroups(record).includes(applicationReviewerGroups[0]),
    );
    await this.requireTemplate(credentials);
    const entity = await this.options.catalog.getEntityByRef(
      record.decision.reviewer,
      { credentials },
    );
    if (
      !entity ||
      entity.kind !== 'User' ||
      !(entity.relations ?? []).some(
        r =>
          r.type === 'memberOf' &&
          this.reviewerGroups(record).includes(r.targetRef),
      )
    )
      throw new NotAllowedError('Cloud reviewer membership changed');
  }
  private async dispatch(
    record: CloudProposalRecord,
  ): Promise<CloudProposalRecord> {
    const claim = randomBytes(32).toString('base64url');
    const claimed = await this.replace(record, {
      ...record,
      status: 'scaffolding',
      execution: { state: 'claimed', claimHash: claimHash(claim) },
    });
    try {
      await this.reviewerStillAuthorized(claimed);
      await this.recheck(claimed);
      const credentials = await this.options.auth.getOwnServiceCredentials();
      const { taskId } = await this.options.scaffolder.scaffold(
        {
          templateRef: 'template:default/deploy-rizz-ai',
          values: {},
          secrets: {
            AGENT_GUARD_CLOUD_PROPOSAL_ID: record.id,
            AGENT_GUARD_CLOUD_EXECUTION_CLAIM: claim,
          },
        },
        { credentials },
      );
      if (!taskId) throw new Error('Missing task identity');
      return await this.replace(claimed, {
        ...claimed,
        execution: { ...claimed.execution!, state: 'task_started', taskId },
      });
    } catch {
      // A lost dispatch response is ambiguous. Never auto-retry into two tasks.
      this.options.logger.warn('Cloud Scaffolder handoff failed', {
        proposalId: record.id,
      });
      return this.replace(claimed, {
        ...claimed,
        status: 'execution_failed',
        execution: {
          ...claimed.execution!,
          state: 'failed',
          errorCode: 'scaffolder_handoff_failed',
        },
      });
    }
  }
  private requireClaim(
    record: CloudProposalRecord,
    input: { claim: string; taskId: string },
  ) {
    const expected = record.execution?.claimHash;
    if (
      !expected ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      !timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(claimHash(input.claim), 'hex'),
      )
    )
      throw new NotAllowedError('Invalid cloud execution claim');
    if (record.execution?.state === 'claimed')
      throw new ConflictError('task_not_bound');
    if (record.execution?.taskId !== input.taskId)
      throw new NotAllowedError('Wrong cloud task identity');
  }
  async reservePublish(input: {
    proposalId: string;
    taskId: string;
    claim: string;
  }): Promise<{
    operation: CloudProposalRecord['snapshot']['envelope']['kind'];
    files: CloudProposalRecord['snapshot']['files'];
    deletePaths?: string[];
    target: CloudTarget;
    baseRevision: string;
    branchName: string;
    approvedDigest: string;
    createdAt: string;
  }> {
    const record = await this.stored(input.proposalId);
    this.requireClaim(record, input);
    const firstReservation =
      record.status === 'scaffolding' &&
      record.execution?.state === 'task_started';
    const recovery =
      record.status === 'publishing' &&
      record.execution?.state === 'publishing';
    if (!firstReservation && !recovery)
      throw new ConflictError('Cloud publication is not available');
    if (!this.resolvedTarget)
      return (await this.forRequest()).reservePublish(input);
    await this.reviewerStillAuthorized(record);
    await this.recheck(record);
    if (firstReservation)
      await this.replace(record, {
        ...record,
        status: 'publishing',
        execution: { ...record.execution!, state: 'publishing' },
      });
    // Backend-owned frozen bytes, never agent-rendered files/configuration.
    return {
      operation: record.snapshot.envelope.kind,
      files: record.snapshot.files,
      ...('deletePaths' in record.snapshot
        ? { deletePaths: record.snapshot.deletePaths }
        : {}),
      target: record.snapshot.envelope.target,
      baseRevision: record.snapshot.envelope.gitopsBase.revision,
      branchName: `agent-guard-cloud/${record.id}`,
      approvedDigest: record.snapshot.digest,
      createdAt: record.createdAt,
    };
  }
  async completePublish(input: {
    proposalId: string;
    taskId: string;
    claim: string;
    prUrl: string;
    prNumber: number;
  }) {
    const record = await this.stored(input.proposalId);
    this.requireClaim(record, input);
    if (
      record.status !== 'publishing' ||
      record.execution?.state !== 'publishing'
    )
      throw new ConflictError('No cloud publication awaiting completion');
    const repo = this.configuredTarget.gitopsRepository.replace(/\.git$/, '');
    if (
      !Number.isSafeInteger(input.prNumber) ||
      input.prNumber < 1 ||
      input.prUrl !== `${repo}/pull/${input.prNumber}`
    )
      throw new ConflictError(
        'Cloud PR destination differs from approved repository',
      );
    await this.replace(record, {
      ...record,
      status: 'pr_open',
      execution: {
        ...record.execution,
        state: 'pr_open',
        prUrl: input.prUrl,
        prNumber: input.prNumber,
      },
    });
  }
}
