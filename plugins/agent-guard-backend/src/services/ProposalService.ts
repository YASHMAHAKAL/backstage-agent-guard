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
} from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { ScaffolderService } from '@backstage/plugin-scaffolder-node';
import {
  decideReview,
  proposalInputSchema,
  ProposalDecisionInput,
  ProposalInput,
  ProposalStatus,
  ReviewLane,
  SemanticResult,
} from '../domain';
import { JevClient } from '../jev';
import { DeliveryStatusObserver } from '../deliveryStatus';
import {
  createFrozenSnapshot,
  FrozenSnapshot,
  IntentSource,
  snapshotHasIntegrity,
  SubmissionChannel,
} from '../snapshot';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

function claimDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function claimMatches(expected: string | undefined, supplied: string): boolean {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(claimDigest(supplied), 'hex'),
  );
}

export interface PublishPlan {
  repoUrl: string;
  branchName: string;
  targetBranchName: 'main';
  targetPath: string;
  title: string;
  description: string;
}

export interface ProposalAuditEvent {
  type:
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'execution_claimed'
    | 'scaffolder_task_started'
    | 'scaffolder_task_completed'
    | 'publish_claimed'
    | 'pr_opened'
    | 'execution_failed';
  actor: string;
  at: string;
  digest: string;
  submissionChannel?: SubmissionChannel;
  comment?: string;
}

export interface ProposalDecisionRecord {
  decision: 'approve' | 'reject';
  reviewer: string;
  decidedAt: string;
  digest: string;
  comment?: string;
}

export interface ProposalRecord {
  id: string;
  declaredIntent: string;
  intentSource: IntentSource;
  // Absent on historical records; never inferred from their intent text.
  submissionChannel?: SubmissionChannel;
  templateId: ProposalInput['templateId'];
  inputs: ProposalInput['inputs'];
  requester: string;
  status: ProposalStatus;
  reviewLane: ReviewLane;
  reasonCodes: string[];
  semantic: SemanticResult;
  snapshot?: FrozenSnapshot;
  decision?: ProposalDecisionRecord;
  execution?: {
    state:
      | 'claimed'
      | 'task_started'
      | 'publishing'
      | 'pr_open'
      | 'completed'
      | 'failed';
    claimedAt: string;
    claimHash?: string;
    taskId?: string;
    prUrl?: string;
    prNumber?: number;
    errorCode?:
      | 'scaffolder_dispatch_failed'
      | 'scaffolder_task_failed'
      | 'publisher_not_run';
  };
  auditTrail?: ProposalAuditEvent[];
  createdAt: string;
  updatedAt?: string;
}

export interface ProposalView extends Omit<ProposalRecord, 'execution'> {
  execution?: Omit<NonNullable<ProposalRecord['execution']>, 'claimHash'>;
  viewerPermissions: {
    canReview: boolean;
    reason: string;
  };
}

interface ViewerContext {
  userRef: string;
  ownershipEntityRefs: string[];
}

export class ProposalService {
  private constructor(
    private readonly client: DatabaseClient,
    private readonly catalog: typeof catalogServiceRef.T,
    private readonly auth: AuthService,
    private readonly scaffolder: ScaffolderService,
    private readonly userInfo: UserInfoService,
    private readonly jev: JevClient,
    private readonly logger: LoggerService,
    private readonly authMode: 'guest-demo' | 'github',
    private readonly gitopsRepoUrl?: string,
    private readonly deliveryObserver: DeliveryStatusObserver = new DeliveryStatusObserver(),
  ) {}

  static async create(options: {
    database: DatabaseService;
    catalog: typeof catalogServiceRef.T;
    auth: AuthService;
    scaffolder: ScaffolderService;
    userInfo: UserInfoService;
    jev: JevClient;
    logger: LoggerService;
    authMode: 'guest-demo' | 'github';
    gitopsRepoUrl?: string;
    deliveryObserver?: DeliveryStatusObserver;
  }): Promise<ProposalService> {
    const client = await options.database.getClient();
    if (!(await client.schema.hasTable('proposals'))) {
      await client.schema.createTable('proposals', table => {
        table.string('id').primary();
        table.string('requester').notNullable().index();
        table.string('status').notNullable().index();
        table.text('record').notNullable();
        table.timestamp('created_at').notNullable();
      });
    }
    return new ProposalService(
      client,
      options.catalog,
      options.auth,
      options.scaffolder,
      options.userInfo,
      options.jev,
      options.logger,
      options.authMode,
      options.gitopsRepoUrl,
      options.deliveryObserver,
    );
  }

  async submit(
    input: unknown,
    credentials: BackstageCredentials,
    submissionChannel: SubmissionChannel,
  ): Promise<ProposalView> {
    const viewer = await this.getViewer(credentials, 'Submitting');
    const parsed = proposalInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InputError(parsed.error.message);
    }
    const proposal = parsed.data;
    const owner = await this.catalog.getEntityByRef(
      proposal.inputs.requestedOwner,
      { credentials },
    );
    if (!owner || owner.kind !== 'Group') {
      throw new InputError('Requested owner must be an existing catalog Group');
    }
    const semantic = await this.jev.evaluate(proposal);
    const review = decideReview({
      semantic,
      owner: proposal.inputs.requestedOwner,
      ownershipEntityRefs: viewer.ownershipEntityRefs,
    });
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // A REST caller is authenticated as a Backstage user, but this does not
    // prove that a human personally typed the intent or clicked Submit.
    const intentSource: IntentSource =
      submissionChannel === 'backstage_rest'
        ? 'authenticated_user_submitted'
        : 'agent_supplied';
    const snapshot = createFrozenSnapshot({
      proposalId: id,
      proposal,
      requester: viewer.userRef,
      intentSource,
      submissionChannel,
      gitopsRepoUrl: this.gitopsRepoUrl,
    });
    const record: ProposalRecord = {
      id,
      declaredIntent: proposal.declaredIntent,
      intentSource,
      submissionChannel,
      templateId: proposal.templateId,
      inputs: proposal.inputs,
      requester: viewer.userRef,
      status: review.status,
      reviewLane: review.reviewLane,
      reasonCodes: review.reasonCodes,
      semantic,
      snapshot,
      auditTrail: [
        {
          type: 'submitted',
          actor: viewer.userRef,
          at: createdAt,
          digest: snapshot.digest,
          submissionChannel,
        },
      ],
      createdAt,
      updatedAt: createdAt,
    };
    await this.client('proposals').insert({
      id: record.id,
      requester: record.requester,
      status: record.status,
      record: JSON.stringify(record),
      created_at: record.createdAt,
    });
    this.logger.info('Agent Guard proposal submitted', {
      proposalId: record.id,
      status: record.status,
      digest: snapshot.digest,
    });
    return this.toView(record, viewer);
  }

  async get(
    id: string,
    credentials: BackstageCredentials,
  ): Promise<ProposalView> {
    const viewer = await this.getViewer(credentials, 'Viewing');
    const record = await this.getStored(id);
    if (!this.canView(record, viewer)) {
      throw new NotAllowedError('You cannot view this proposal');
    }
    return this.toView(await this.refreshExecution(record), viewer);
  }

  async getDelivery(id: string, credentials: BackstageCredentials) {
    const viewer = await this.getViewer(credentials, 'Viewing');
    const record = await this.getStored(id);
    if (!this.canView(record, viewer)) {
      throw new NotAllowedError('You cannot view this proposal');
    }
    return this.deliveryObserver.observe(record);
  }

  async list(credentials: BackstageCredentials): Promise<ProposalView[]> {
    const viewer = await this.getViewer(credentials, 'Listing');
    const rows = await this.client('proposals').orderBy('created_at', 'desc');
    const visible = rows
      .map(row => JSON.parse(row.record) as ProposalRecord)
      .filter(record => this.canView(record, viewer));
    return Promise.all(
      visible.map(async record =>
        this.toView(await this.refreshExecution(record), viewer),
      ),
    );
  }

  async decide(
    id: string,
    input: ProposalDecisionInput,
    credentials: BackstageCredentials,
  ): Promise<ProposalView> {
    const viewer = await this.getViewer(credentials, 'Reviewing');
    const record = await this.getStored(id);
    if (!this.canView(record, viewer)) {
      throw new NotAllowedError('You cannot view this proposal');
    }
    if (record.status !== 'pending_approval') {
      throw new ConflictError('Only a pending proposal can be reviewed');
    }
    if (!record.snapshot) {
      throw new ConflictError(
        'This legacy proposal has no frozen snapshot; submit a new proposal',
      );
    }
    if (
      !this.snapshotIsCurrent(record) ||
      input.digest !== record.snapshot.digest
    ) {
      throw new ConflictError(
        'The approved digest does not match the current frozen proposal',
      );
    }
    if (!this.canReview(record, viewer)) {
      throw new NotAllowedError(
        'You are not an authorized reviewer for this proposal',
      );
    }

    const decidedAt = new Date().toISOString();
    const status: ProposalStatus =
      input.decision === 'approve' ? 'approved' : 'rejected';
    const updated: ProposalRecord = {
      ...record,
      status,
      decision: {
        decision: input.decision,
        reviewer: viewer.userRef,
        decidedAt,
        digest: record.snapshot.digest,
        ...(input.comment ? { comment: input.comment } : {}),
      },
      auditTrail: [
        ...(record.auditTrail ?? []),
        {
          type: input.decision === 'approve' ? 'approved' : 'rejected',
          actor: viewer.userRef,
          at: decidedAt,
          digest: record.snapshot.digest,
          ...(input.comment ? { comment: input.comment } : {}),
        },
      ],
      updatedAt: decidedAt,
    };
    const changed = await this.client('proposals')
      .where({ id: record.id, status: 'pending_approval' })
      .update({ status, record: JSON.stringify(updated) });
    if (changed !== 1) {
      throw new ConflictError('Proposal state changed while it was reviewed');
    }
    this.logger.info(`Agent Guard proposal ${status}`, {
      proposalId: record.id,
      reviewer: viewer.userRef,
      digest: record.snapshot.digest,
    });
    if (status === 'approved') {
      // Approval is durable before dispatch. A failed/ambiguous dispatch is
      // recorded, never silently retried into a second task.
      return this.toView(await this.dispatchApproved(record.id), viewer);
    }
    return this.toView(updated, viewer);
  }

  private async dispatchApproved(id: string): Promise<ProposalRecord> {
    const record = await this.getStored(id);
    if (
      record.status !== 'approved' ||
      record.decision?.decision !== 'approve' ||
      record.decision.reviewer === record.requester ||
      !record.snapshot ||
      record.execution
    ) {
      throw new ConflictError('Proposal is not eligible for execution');
    }
    if (
      !this.snapshotIsCurrent(record) ||
      record.decision.digest !== record.snapshot.digest
    ) {
      throw new ConflictError('Approved snapshot is no longer executable');
    }

    const claimedAt = new Date().toISOString();
    const claim = this.gitopsRepoUrl
      ? randomBytes(32).toString('base64url')
      : undefined;
    const claimed: ProposalRecord = {
      ...record,
      status: 'scaffolding',
      execution: {
        state: 'claimed',
        claimedAt,
        ...(claim ? { claimHash: claimDigest(claim) } : {}),
      },
      auditTrail: [
        ...(record.auditTrail ?? []),
        {
          type: 'execution_claimed',
          actor: 'service:agent-guard',
          at: claimedAt,
          digest: record.snapshot.digest,
        },
      ],
      updatedAt: claimedAt,
    };
    const changed = await this.client('proposals')
      .where({ id, status: 'approved' })
      .update({ status: 'scaffolding', record: JSON.stringify(claimed) });
    if (changed !== 1) {
      // Another request already claimed it; never dispatch twice.
      return this.getStored(id);
    }

    try {
      const credentials = await this.auth.getOwnServiceCredentials();
      const { taskId } = await this.scaffolder.scaffold(
        {
          templateRef: `template:default/${record.templateId}`,
          values: record.inputs,
          ...(claim
            ? {
                secrets: {
                  AGENT_GUARD_PROPOSAL_ID: record.id,
                  AGENT_GUARD_EXECUTION_CLAIM: claim,
                },
              }
            : {}),
        },
        { credentials },
      );
      if (!taskId) {
        throw new Error('Scaffolder did not return a task ID');
      }
      const startedAt = new Date().toISOString();
      const started: ProposalRecord = {
        ...claimed,
        execution: {
          state: 'task_started',
          claimedAt,
          taskId,
          ...(claim ? { claimHash: claimDigest(claim) } : {}),
        },
        auditTrail: [
          ...(claimed.auditTrail ?? []),
          {
            type: 'scaffolder_task_started',
            actor: 'service:agent-guard',
            at: startedAt,
            digest: record.snapshot.digest,
          },
        ],
        updatedAt: startedAt,
      };
      await this.client('proposals')
        .where({ id, status: 'scaffolding' })
        .update({ record: JSON.stringify(started) });
      this.logger.info('Agent Guard Scaffolder task started', {
        proposalId: id,
        taskId,
      });
      return started;
    } catch (error) {
      // A timeout can mean the task started but the response was lost. Do not
      // auto-retry: that could duplicate a later GitOps publishing side effect.
      const failedAt = new Date().toISOString();
      const failed: ProposalRecord = {
        ...claimed,
        status: 'execution_failed',
        execution: {
          state: 'failed',
          claimedAt,
          errorCode: 'scaffolder_dispatch_failed',
        },
        auditTrail: [
          ...(claimed.auditTrail ?? []),
          {
            type: 'execution_failed',
            actor: 'service:agent-guard',
            at: failedAt,
            digest: record.snapshot.digest,
          },
        ],
        updatedAt: failedAt,
      };
      await this.client('proposals')
        .where({ id, status: 'scaffolding' })
        .update({ status: 'execution_failed', record: JSON.stringify(failed) });
      this.logger.error('Agent Guard Scaffolder dispatch failed', {
        proposalId: id,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return failed;
    }
  }

  async reservePublish(input: {
    proposalId: string;
    taskId: string;
    claim: string;
    files: Array<{ path: string; sha256: string }>;
  }): Promise<PublishPlan> {
    const record = await this.getStored(input.proposalId);
    if (!claimMatches(record.execution?.claimHash, input.claim)) {
      throw new NotAllowedError('Invalid execution claim');
    }
    if (record.execution?.state === 'claimed' && !record.execution.taskId) {
      throw new ConflictError('task_not_bound');
    }
    if (
      record.status !== 'scaffolding' ||
      record.execution?.state !== 'task_started' ||
      record.execution.taskId !== input.taskId ||
      record.decision?.decision !== 'approve' ||
      record.decision.reviewer === record.requester ||
      !record.snapshot ||
      !record.snapshot.envelope.gitopsTarget.publishEnabled ||
      !this.gitopsRepoUrl ||
      !this.snapshotIsCurrent(record) ||
      record.decision.digest !== record.snapshot.digest
    ) {
      throw new ConflictError('No live approved task-bound snapshot');
    }
    const targetPath = record.snapshot.envelope.gitopsTarget.path;
    const expectedFiles = record.snapshot.files
      .map(file => ({
        path: file.path.slice(targetPath.length + 1),
        sha256: file.sha256,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const providedFiles = [...input.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    if (JSON.stringify(providedFiles) !== JSON.stringify(expectedFiles)) {
      throw new ConflictError('Rendered files differ from approved snapshot');
    }

    const at = new Date().toISOString();
    const updated: ProposalRecord = {
      ...record,
      status: 'publishing',
      execution: { ...record.execution, state: 'publishing' },
      auditTrail: [
        ...(record.auditTrail ?? []),
        {
          type: 'publish_claimed',
          actor: 'service:scaffolder',
          at,
          digest: record.snapshot.digest,
        },
      ],
      updatedAt: at,
    };
    const changed = await this.client('proposals')
      .where({ id: record.id, status: 'scaffolding' })
      .update({ status: 'publishing', record: JSON.stringify(updated) });
    if (changed !== 1) {
      throw new ConflictError('Publishing was already claimed');
    }
    return {
      repoUrl: this.gitopsRepoUrl,
      branchName: `agent-guard/${record.id}`,
      targetBranchName: 'main',
      targetPath,
      title: `Deploy ${record.inputs.serviceName} to staging`,
      description: `Agent Guard proposal ${record.id}\nApproved digest: ${record.snapshot.digest}`,
    };
  }

  async completePublish(input: {
    proposalId: string;
    taskId: string;
    claim: string;
    prUrl: string;
    prNumber: number;
  }): Promise<void> {
    const record = await this.getStored(input.proposalId);
    if (!claimMatches(record.execution?.claimHash, input.claim)) {
      throw new NotAllowedError('Invalid execution claim');
    }
    if (
      record.status !== 'publishing' ||
      record.execution?.state !== 'publishing' ||
      record.execution.taskId !== input.taskId ||
      !record.snapshot ||
      !this.snapshotIsCurrent(record)
    ) {
      throw new ConflictError('No publishing task is awaiting completion');
    }
    const target = new URL(
      `https://${record.snapshot.envelope.gitopsTarget.repository}`,
    );
    const owner = target.searchParams.get('owner');
    const repo = target.searchParams.get('repo');
    const actual = new URL(input.prUrl);
    const expectedPath = `/${owner}/${repo}/pull/${input.prNumber}`;
    if (
      actual.protocol !== 'https:' ||
      actual.host !== 'github.com' ||
      actual.username ||
      actual.password ||
      actual.search ||
      actual.hash ||
      actual.pathname.toLowerCase() !== expectedPath.toLowerCase()
    ) {
      throw new ConflictError('PR URL does not match approved repository');
    }
    const at = new Date().toISOString();
    const updated: ProposalRecord = {
      ...record,
      status: 'pr_open',
      execution: {
        ...record.execution,
        state: 'pr_open',
        prUrl: input.prUrl,
        prNumber: input.prNumber,
      },
      auditTrail: [
        ...(record.auditTrail ?? []),
        {
          type: 'pr_opened',
          actor: 'service:scaffolder',
          at,
          digest: record.snapshot.digest,
        },
      ],
      updatedAt: at,
    };
    const changed = await this.client('proposals')
      .where({ id: record.id, status: 'publishing' })
      .update({ status: 'pr_open', record: JSON.stringify(updated) });
    if (changed !== 1) {
      throw new ConflictError('Publishing completion was already recorded');
    }
  }

  private async refreshExecution(
    record: ProposalRecord,
  ): Promise<ProposalRecord> {
    const execution = record.execution;
    if (
      !['scaffolding', 'publishing'].includes(record.status) ||
      !execution ||
      !['task_started', 'publishing'].includes(execution.state) ||
      !execution.taskId ||
      !record.snapshot
    ) {
      return record;
    }
    let taskStatus: string;
    try {
      const credentials = await this.auth.getOwnServiceCredentials();
      const task = await this.scaffolder.getTask(
        { taskId: execution.taskId },
        { credentials },
      );
      taskStatus = task.status;
    } catch {
      // A temporary Scaffolder outage must not turn a running task into a
      // failure or allow a second dispatch.
      return record;
    }
    if (!['completed', 'failed', 'cancelled'].includes(taskStatus)) {
      return record;
    }
    // If GitHub may already have been contacted, completion without the
    // callback is ambiguous. Never treat it as a safe-to-retry failure.
    if (record.status === 'publishing' && taskStatus === 'completed') {
      return record;
    }
    const completed = taskStatus === 'completed';
    const at = new Date().toISOString();
    let status: ProposalStatus = 'execution_failed';
    if (
      record.status === 'publishing' ||
      (completed && record.snapshot.envelope.gitopsTarget.publishEnabled)
    ) {
      status = 'publish_failed';
    } else if (completed) {
      status = 'render_complete';
    }
    let errorCode: NonNullable<ProposalRecord['execution']>['errorCode'];
    if (status === 'publish_failed' && completed) {
      errorCode = 'publisher_not_run';
    } else if (!completed) {
      errorCode = 'scaffolder_task_failed';
    }
    const updated: ProposalRecord = {
      ...record,
      status,
      execution: {
        ...execution,
        state: completed ? 'completed' : 'failed',
        ...(errorCode ? { errorCode } : {}),
      },
      auditTrail: [
        ...(record.auditTrail ?? []),
        {
          type: completed ? 'scaffolder_task_completed' : 'execution_failed',
          actor: 'service:agent-guard',
          at,
          digest: record.snapshot.digest,
        },
      ],
      updatedAt: at,
    };
    const changed = await this.client('proposals')
      .where({ id: record.id, status: record.status })
      .update({ status, record: JSON.stringify(updated) });
    return changed === 1 ? updated : this.getStored(record.id);
  }

  private async getViewer(
    credentials: BackstageCredentials,
    operation: string,
  ): Promise<ViewerContext> {
    if (!this.auth.isPrincipal(credentials, 'user')) {
      throw new NotAllowedError(
        `${operation} a proposal requires a user identity`,
      );
    }
    if (
      this.authMode === 'github' &&
      credentials.principal.userEntityRef === 'user:default/guest'
    ) {
      throw new NotAllowedError('Shared guest identity is disabled');
    }
    const info = await this.userInfo.getUserInfo(credentials);
    return {
      userRef: credentials.principal.userEntityRef,
      ownershipEntityRefs: info.ownershipEntityRefs,
    };
  }

  private async getStored(id: string): Promise<ProposalRecord> {
    const row = await this.client('proposals').where({ id }).first();
    if (!row) {
      throw new NotFoundError('Proposal not found');
    }
    return JSON.parse(row.record) as ProposalRecord;
  }

  private canView(record: ProposalRecord, viewer: ViewerContext): boolean {
    return (
      record.requester === viewer.userRef ||
      viewer.ownershipEntityRefs.includes(record.inputs.requestedOwner)
    );
  }

  private canReview(record: ProposalRecord, viewer: ViewerContext): boolean {
    if (
      record.status !== 'pending_approval' ||
      !this.snapshotIsCurrent(record)
    ) {
      return false;
    }
    // A shared guest account is never a trustworthy requester or reviewer.
    // This also keeps guest-demo proposals inert after GitHub mode is enabled.
    if (
      record.requester === 'user:default/guest' ||
      viewer.userRef === 'user:default/guest'
    ) {
      return false;
    }
    return (
      record.reviewLane === 'owner_review' &&
      viewer.userRef !== record.requester &&
      viewer.ownershipEntityRefs.includes(record.inputs.requestedOwner)
    );
  }

  private snapshotIsCurrent(record: ProposalRecord): boolean {
    if (!record.snapshot || !snapshotHasIntegrity(record.snapshot)) {
      return false;
    }
    const expected = createFrozenSnapshot({
      proposalId: record.id,
      proposal: {
        declaredIntent: record.declaredIntent,
        templateId: record.templateId,
        inputs: record.inputs,
      },
      requester: record.requester,
      intentSource: record.intentSource,
      submissionChannel: record.submissionChannel,
      gitopsRepoUrl: this.gitopsRepoUrl,
    });
    return record.snapshot.digest === expected.digest;
  }

  private toView(record: ProposalRecord, viewer: ViewerContext): ProposalView {
    const canReview = this.canReview(record, viewer);
    let reason = 'Proposal is not awaiting review';
    if (canReview) {
      reason = 'You are authorized to review this frozen proposal';
    } else if (record.status === 'pending_approval') {
      if (!this.snapshotIsCurrent(record)) {
        reason =
          'Approval policy or frozen files changed; submit a new proposal';
      } else if (record.requester === 'user:default/guest') {
        reason = 'Shared guest proposals are demo-only; resubmit with GitHub';
      } else if (viewer.userRef === 'user:default/guest') {
        reason = 'Shared guest identity cannot review proposals';
      } else if (record.reviewLane !== 'owner_review') {
        reason = 'Legacy review lane is disabled; submit a new proposal';
      } else if (record.requester === viewer.userRef) {
        reason = 'A different member of the requested owner group must review';
      } else {
        reason = 'Review requires membership in the requested owner group';
      }
    }
    const { execution, ...safeRecord } = record;
    const safeExecution = execution
      ? (({ claimHash: _claimHash, ...visible }) => visible)(execution)
      : undefined;
    return {
      ...safeRecord,
      execution: safeExecution,
      viewerPermissions: { canReview, reason },
    };
  }
}
