import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AuthService,
  BackstageCredentials,
  DatabaseService,
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
import { z } from 'zod/v3';
import { canonicalize } from '../snapshot';
import {
  assertTerraformPlanScope,
  signTerraformApproval,
  terraformBindingDigest,
  terraformPlanBindingSchema,
  terraformPlanSummarySchema,
  TerraformApprovalReceipt,
  TerraformPlanBinding,
} from '../terraformPlan';
import {
  CapacityBaseline,
  CapacityPr,
  TerraformCapacityPublisher,
} from '../terraformCapacityPublisher';
import { TerraformAwsReader } from '../terraformObservation';

type Client = Awaited<ReturnType<DatabaseService['getClient']>>;
const platformGroup = 'group:default/platform-team';
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const declaredIntent = z.string().trim().min(20).max(1000);
const requestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('foundation_setup'),
      root: z.enum(['registry', 'staging']),
      declaredIntent,
    })
    .strict(),
  z
    .object({
      operation: z.literal('capacity_change'),
      root: z.literal('staging'),
      desiredWorkers: z.number().int().min(1).max(2),
      declaredIntent,
    })
    .strict(),
]);
const configurationPrSchema = z
  .object({
    url: z.string().url().max(300),
    mergedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
const planRegistrationSchema = z
  .object({
    requestId: z.string().uuid(),
    binding: terraformPlanBindingSchema,
    summary: terraformPlanSummarySchema,
    configurationPr: configurationPrSchema,
    proof: digestSchema,
  })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    bindingDigest: digestSchema,
    comment: z.string().trim().max(500).optional(),
  })
  .strict();
const receiptRequestSchema = z
  .object({ requestId: z.string().uuid(), proof: digestSchema })
  .strict();
const runnerRequestSchema = receiptRequestSchema;
const runnerOutcomeSchema = z
  .object({
    requestId: z.string().uuid(),
    bindingDigest: digestSchema,
    runId: z.string().uuid(),
    status: z.enum(['applied', 'unknown']),
    proof: digestSchema,
  })
  .strict();

type SanitizedPlan = z.infer<typeof terraformPlanSummarySchema>;
type Request = z.infer<typeof requestSchema>;
type ConfigurationPr = z.infer<typeof configurationPrSchema>;
type Status =
  | 'awaiting_configuration_pr'
  | 'configuration_pr_open'
  | 'awaiting_plan_review'
  | 'plan_approved'
  | 'plan_rejected'
  | 'runner_reported_applied'
  | 'runner_unknown';
interface RecordData {
  id: string;
  version: number;
  status: Status;
  request: Request;
  capacityBaseline?: CapacityBaseline;
  configurationPrDraft?: CapacityPr;
  requester: string;
  createdAt: string;
  plan?: {
    binding: TerraformPlanBinding;
    bindingDigest: string;
    summary: SanitizedPlan;
    configurationPr: ConfigurationPr;
    registeredAt: string;
  };
  decision?: {
    decision: 'approve' | 'reject';
    reviewer: string;
    bindingDigest: string;
    at: string;
    comment?: string;
  };
  receipt?: TerraformApprovalReceipt;
  runnerOutcome?: {
    runId: string;
    bindingDigest: string;
    status: 'applied' | 'unknown';
    reportedAt: string;
  };
  audit: Array<{ event: string; actor: string; at: string }>;
}

/** Read-only evidence adapter. A PR URL supplied by a user or runner is not
 * proof that reviewed Terraform configuration was merged. */
export interface TerraformConfigurationReader {
  verifyMergedReview(input: {
    pullRequest: ConfigurationPr;
    sourceCommit: string;
    root: Request['root'];
    requesterRef: string;
    capacityDesiredWorkers?: number;
    capacityPrHeadCommit?: string;
  }): Promise<boolean>;
}

export class TerraformControlService {
  private constructor(
    private readonly client: Client,
    private readonly options: {
      auth: AuthService;
      userInfo: UserInfoService;
      catalog: typeof catalogServiceRef.T;
      runnerKey: Buffer;
      approvalKey: Buffer;
      expectedAccountId: string;
      expectedRunnerId: string;
      configurationReader: TerraformConfigurationReader;
      capacityPublisher?: TerraformCapacityPublisher;
      awsObserver?: TerraformAwsReader;
    },
  ) {}

  static async create(options: {
    database: DatabaseService;
    auth: AuthService;
    userInfo: UserInfoService;
    catalog: typeof catalogServiceRef.T;
    runnerKey: Buffer;
    approvalKey: Buffer;
    expectedAccountId: string;
    expectedRunnerId: string;
    configurationReader: TerraformConfigurationReader;
    capacityPublisher?: TerraformCapacityPublisher;
    awsObserver?: TerraformAwsReader;
  }) {
    if (
      options.runnerKey.length < 32 ||
      options.approvalKey.length < 32 ||
      options.runnerKey.equals(options.approvalKey) ||
      !/^[0-9]{12}$/.test(options.expectedAccountId) ||
      !/^[a-z0-9][a-z0-9-]{2,80}$/.test(options.expectedRunnerId)
    )
      throw new ServiceUnavailableError(
        'Invalid Terraform control target or keys',
      );
    const client = await options.database.getClient();
    if (!(await client.schema.hasTable('rizz_terraform_requests'))) {
      await client.schema.createTable('rizz_terraform_requests', table => {
        table.string('id').primary();
        table.integer('version').notNullable();
        table.string('status').notNullable().index();
        table.string('requester').notNullable().index();
        table.text('record').notNullable();
        table.timestamp('created_at').notNullable();
      });
    }
    return new TerraformControlService(client, options);
  }

  private async platformUser(credentials: BackstageCredentials) {
    if (
      !this.options.auth.isPrincipal(credentials, 'user') ||
      credentials.principal.userEntityRef === 'user:default/guest'
    )
      throw new NotAllowedError('A mapped platform user is required');
    const ref = credentials.principal.userEntityRef;
    const [info, user, group] = await Promise.all([
      this.options.userInfo.getUserInfo(credentials),
      this.options.catalog.getEntityByRef(ref, { credentials }),
      this.options.catalog.getEntityByRef(platformGroup, { credentials }),
    ]);
    if (
      !user ||
      user.kind !== 'User' ||
      !group ||
      group.kind !== 'Group' ||
      !info.ownershipEntityRefs.includes(platformGroup) ||
      !(user.relations ?? []).some(
        relation =>
          relation.type === 'memberOf' && relation.targetRef === platformGroup,
      )
    )
      throw new NotAllowedError('Current platform-team membership is required');
    return ref;
  }

  private async currentPlatformReviewer(ref: string) {
    const credentials = await this.options.auth.getOwnServiceCredentials();
    const [user, group] = await Promise.all([
      this.options.catalog.getEntityByRef(ref, { credentials }),
      this.options.catalog.getEntityByRef(platformGroup, { credentials }),
    ]);
    return (
      !!user &&
      user.kind === 'User' &&
      !!group &&
      group.kind === 'Group' &&
      (user.relations ?? []).some(
        relation =>
          relation.type === 'memberOf' && relation.targetRef === platformGroup,
      )
    );
  }

  private async load(id: string): Promise<RecordData> {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success)
      throw new InputError('Invalid infrastructure request ID');
    const row = await this.client('rizz_terraform_requests')
      .where({ id })
      .first<{ record: string }>();
    if (!row) throw new NotFoundError('Infrastructure request not found');
    return JSON.parse(row.record) as RecordData;
  }

  private async replace(previous: RecordData, next: RecordData) {
    const changed = await this.client('rizz_terraform_requests')
      .where({ id: previous.id, version: previous.version })
      .update({
        version: next.version,
        status: next.status,
        record: JSON.stringify(next),
      });
    if (changed !== 1)
      throw new ConflictError('Infrastructure request changed concurrently');
  }

  async submit(raw: unknown, credentials: BackstageCredentials) {
    const requester = await this.platformUser(credentials);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw new InputError('Invalid foundation request');
    if (
      parsed.data.operation === 'capacity_change' &&
      !this.options.capacityPublisher
    )
      throw new ServiceUnavailableError(
        'Bounded capacity publishing is not configured',
      );
    const baseline =
      parsed.data.operation === 'capacity_change'
        ? await this.options.capacityPublisher!.readBaseline()
        : undefined;
    if (
      parsed.data.operation === 'capacity_change' &&
      baseline?.workers === parsed.data.desiredWorkers
    )
      throw new InputError('Requested worker count already matches main');
    const now = new Date().toISOString();
    const record: RecordData = {
      id: randomUUID(),
      version: 1,
      status: 'awaiting_configuration_pr',
      request: parsed.data,
      ...(baseline ? { capacityBaseline: baseline } : {}),
      requester,
      createdAt: now,
      audit: [{ event: 'submitted', actor: requester, at: now }],
    };
    await this.client('rizz_terraform_requests').insert({
      id: record.id,
      version: record.version,
      status: record.status,
      requester,
      record: JSON.stringify(record),
      created_at: now,
    });
    return this.publicView(record, requester);
  }

  private publicView(record: RecordData, viewer: string) {
    const { receipt: _receipt, ...safe } = record;
    return {
      ...safe,
      canReview:
        record.status === 'awaiting_plan_review' &&
        record.requester !== viewer &&
        !!record.plan &&
        Date.now() < Date.parse(record.plan.binding.expiresAt),
      executable: false as const,
    };
  }

  capacityPublishingAvailable() {
    return !!this.options.capacityPublisher;
  }

  /** Opens only a one-file configuration PR. Foundation setup remains a
   * platform-authored repository change with a separate plan review. */
  async publishCapacity(id: string, credentials: BackstageCredentials) {
    const requester = await this.platformUser(credentials);
    const record = await this.load(id);
    if (!this.options.capacityPublisher)
      throw new ServiceUnavailableError(
        'Bounded capacity publishing is not configured',
      );
    if (
      record.request.operation !== 'capacity_change' ||
      !record.capacityBaseline
    )
      throw new InputError('Only bounded capacity requests can publish a PR');
    if (record.requester !== requester)
      throw new NotAllowedError(
        'Only the original requester may publish this configuration PR',
      );
    if (
      record.status === 'configuration_pr_open' &&
      record.configurationPrDraft
    )
      return this.publicView(record, requester);
    if (record.status !== 'awaiting_configuration_pr')
      throw new ConflictError(
        'This request is no longer awaiting a configuration PR',
      );
    const draft = await this.options.capacityPublisher.publish({
      requestId: record.id,
      requester,
      desiredWorkers: record.request.desiredWorkers,
      baseline: record.capacityBaseline,
    });
    const now = new Date().toISOString();
    const next: RecordData = {
      ...record,
      version: record.version + 1,
      status: 'configuration_pr_open',
      configurationPrDraft: draft,
      audit: [
        ...record.audit,
        { event: 'configuration_pr_opened', actor: requester, at: now },
      ],
    };
    await this.replace(record, next);
    return this.publicView(next, requester);
  }

  async list(credentials: BackstageCredentials) {
    const viewer = await this.platformUser(credentials);
    const rows = await this.client('rizz_terraform_requests')
      .orderBy('created_at', 'desc')
      .limit(100)
      .select<{ record: string }[]>('record');
    return rows.map(row =>
      this.publicView(JSON.parse(row.record) as RecordData, viewer),
    );
  }

  async get(id: string, credentials: BackstageCredentials) {
    const viewer = await this.platformUser(credentials);
    return this.publicView(await this.load(id), viewer);
  }

  /** An independent but deliberately partial AWS inventory. Never treat a
   * runner callback or this subset of resources as deployment proof. */
  async observe(id: string, credentials: BackstageCredentials) {
    await this.platformUser(credentials);
    const record = await this.load(id);
    if (!this.options.awsObserver)
      return { state: 'not_configured' as const, root: record.request.root };
    return this.options.awsObserver.observe(record.request.root);
  }

  /** Service-only immutable request description for the designated runner.
   * The proof authenticates the runner in addition to Backstage's service
   * principal. No receipt, review decision, or arbitrary Terraform input is
   * returned. */
  async runnerRequest(raw: unknown) {
    const input = runnerRequestSchema.safeParse(raw);
    if (!input.success) throw new InputError('Invalid runner request lookup');
    this.verifyRunnerProof(
      { requestId: input.data.requestId },
      input.data.proof,
    );
    const record = await this.load(input.data.requestId);
    if (
      record.status !== 'awaiting_configuration_pr' &&
      record.status !== 'configuration_pr_open'
    )
      throw new ConflictError('Request is no longer awaiting a plan');
    return {
      id: record.id,
      requester: record.requester,
      operation: record.request.operation,
      root: record.request.root,
      createdAt: record.createdAt,
      ...(record.request.operation === 'capacity_change'
        ? {
            desiredWorkers: record.request.desiredWorkers,
            previousWorkers: record.capacityBaseline?.workers,
            configurationPrUrl: record.configurationPrDraft?.url,
            configurationPrHeadCommit: record.configurationPrDraft?.headCommit,
          }
        : {}),
    };
  }

  private verifyRunnerProof(message: unknown, proof: string) {
    const expected = `sha256:${createHmac('sha256', this.options.runnerKey)
      .update(canonicalize(message))
      .digest('hex')}`;
    if (
      !timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(proof, 'utf8'),
      )
    )
      throw new NotAllowedError('Invalid Terraform runner proof');
  }

  /** Service-only callback from a separately credentialed, fixed-root runner.
   * It contains no raw plan or state and cannot itself execute Terraform. */
  async registerPlan(raw: unknown) {
    const input = planRegistrationSchema.safeParse(raw);
    if (!input.success) throw new InputError('Invalid plan registration');
    const { proof, ...message } = input.data;
    this.verifyRunnerProof(message, proof);
    const record = await this.load(message.requestId);
    if (
      record.status !== 'awaiting_configuration_pr' &&
      record.status !== 'configuration_pr_open'
    )
      throw new ConflictError('A plan is already registered or decided');
    const binding = message.binding;
    if (
      binding.requestId !== record.id ||
      binding.requester !== record.requester ||
      binding.operation !== record.request.operation ||
      binding.root !== record.request.root ||
      binding.accountId !== this.options.expectedAccountId ||
      binding.runnerId !== this.options.expectedRunnerId ||
      binding.sourceCommit !== message.configurationPr.mergedCommit ||
      Date.parse(binding.createdAt) < Date.parse(record.createdAt) ||
      Date.parse(binding.createdAt) > Date.now() + 120000 ||
      Date.now() >= Date.parse(binding.expiresAt)
    )
      throw new ConflictError('Plan does not match this live request');
    const summary = message.summary;
    try {
      assertTerraformPlanScope(binding, summary);
    } catch {
      throw new ConflictError('Plan exceeds the reviewed operation scope');
    }
    if (record.request.operation === 'capacity_change') {
      if (
        record.status !== 'configuration_pr_open' ||
        !record.configurationPrDraft ||
        record.configurationPrDraft.url !== message.configurationPr.url ||
        !record.capacityBaseline ||
        summary.changes[0]?.workerDesiredSize?.before !==
          record.capacityBaseline.workers ||
        summary.changes[0]?.workerDesiredSize?.after !==
          record.request.desiredWorkers
      )
        throw new ConflictError(
          'Capacity plan differs from the bounded request or PR',
        );
    }
    const reviewed = await this.options.configurationReader.verifyMergedReview({
      pullRequest: message.configurationPr,
      sourceCommit: binding.sourceCommit,
      root: binding.root,
      requesterRef: record.requester,
      ...(record.request.operation === 'capacity_change'
        ? {
            capacityDesiredWorkers: record.request.desiredWorkers,
            capacityPrHeadCommit: record.configurationPrDraft!.headCommit,
          }
        : {}),
    });
    if (!reviewed)
      throw new ConflictError(
        'Configuration PR is not verified as reviewed and merged',
      );
    const now = new Date().toISOString();
    const next: RecordData = {
      ...record,
      version: record.version + 1,
      status: 'awaiting_plan_review',
      plan: {
        binding,
        bindingDigest: terraformBindingDigest(binding),
        summary,
        configurationPr: message.configurationPr,
        registeredAt: now,
      },
      audit: [
        ...record.audit,
        {
          event: 'plan_registered',
          actor: `runner:${binding.runnerId}`,
          at: now,
        },
      ],
    };
    await this.replace(record, next);
    return { id: next.id, status: next.status };
  }

  async decide(id: string, raw: unknown, credentials: BackstageCredentials) {
    const reviewer = await this.platformUser(credentials);
    const input = decisionSchema.safeParse(raw);
    if (!input.success)
      throw new InputError('Invalid infrastructure plan decision');
    const record = await this.load(id);
    if (record.status !== 'awaiting_plan_review' || !record.plan)
      throw new ConflictError('There is no executable plan awaiting review');
    if (record.requester === reviewer)
      throw new NotAllowedError('The requester cannot review their own plan');
    if (input.data.bindingDigest !== record.plan.bindingDigest)
      throw new ConflictError('The reviewed plan digest changed');
    if (Date.now() >= Date.parse(record.plan.binding.expiresAt))
      throw new ConflictError('The executable plan expired; replan required');
    if (
      !(await this.options.configurationReader.verifyMergedReview({
        pullRequest: record.plan.configurationPr,
        sourceCommit: record.plan.binding.sourceCommit,
        root: record.plan.binding.root,
        requesterRef: record.requester,
        ...(record.request.operation === 'capacity_change'
          ? {
              capacityDesiredWorkers: record.request.desiredWorkers,
              capacityPrHeadCommit: record.configurationPrDraft?.headCommit,
            }
          : {}),
      }))
    )
      throw new ConflictError(
        'The reviewed configuration commit is no longer current',
      );
    const now = new Date().toISOString();
    const decision = {
      ...input.data,
      reviewer,
      at: now,
    };
    const receipt =
      decision.decision === 'approve'
        ? signTerraformApproval(
            {
              binding: record.plan.binding,
              bindingDigest: record.plan.bindingDigest,
              reviewer,
              reviewedAt: now,
              decision: 'approve',
            },
            this.options.approvalKey,
          )
        : undefined;
    const next: RecordData = {
      ...record,
      version: record.version + 1,
      status:
        decision.decision === 'approve' ? 'plan_approved' : 'plan_rejected',
      decision,
      receipt,
      audit: [
        ...record.audit,
        { event: `plan_${decision.decision}`, actor: reviewer, at: now },
      ],
    };
    await this.replace(record, next);
    return this.publicView(next, reviewer);
  }

  /** Service-only receipt retrieval. This does not launch the runner. */
  async approvedReceipt(raw: unknown) {
    const input = receiptRequestSchema.safeParse(raw);
    if (!input.success) throw new InputError('Invalid receipt request');
    this.verifyRunnerProof(
      { requestId: input.data.requestId },
      input.data.proof,
    );
    const record = await this.load(input.data.requestId);
    if (record.status !== 'plan_approved' || !record.receipt || !record.plan)
      throw new ConflictError('No approved plan receipt is available');
    if (Date.now() >= Date.parse(record.plan.binding.expiresAt))
      throw new ConflictError('Plan approval expired');
    if (
      !record.decision ||
      !(await this.currentPlatformReviewer(record.decision.reviewer))
    )
      throw new ConflictError('Plan reviewer is no longer a platform member');
    if (
      !(await this.options.configurationReader.verifyMergedReview({
        pullRequest: record.plan.configurationPr,
        sourceCommit: record.plan.binding.sourceCommit,
        root: record.plan.binding.root,
        requesterRef: record.requester,
        ...(record.request.operation === 'capacity_change'
          ? {
              capacityDesiredWorkers: record.request.desiredWorkers,
              capacityPrHeadCommit: record.configurationPrDraft?.headCommit,
            }
          : {}),
      }))
    )
      throw new ConflictError(
        'The reviewed configuration commit is no longer current',
      );
    return record.receipt;
  }

  /** Runner evidence is not independent proof of infrastructure readiness. */
  async reportRunnerOutcome(raw: unknown) {
    const input = runnerOutcomeSchema.safeParse(raw);
    if (!input.success)
      throw new InputError('Invalid Terraform runner outcome');
    const { proof, ...message } = input.data;
    this.verifyRunnerProof(message, proof);
    const record = await this.load(message.requestId);
    if (record.runnerOutcome) {
      if (
        record.runnerOutcome.runId === message.runId &&
        record.runnerOutcome.bindingDigest === message.bindingDigest &&
        record.runnerOutcome.status === message.status
      )
        return { id: record.id, status: record.status };
      throw new ConflictError('Another runner outcome is already recorded');
    }
    if (
      record.status !== 'plan_approved' ||
      !record.plan ||
      record.plan.bindingDigest !== message.bindingDigest
    )
      throw new ConflictError('Runner outcome does not match an approved plan');
    const now = new Date().toISOString();
    const next: RecordData = {
      ...record,
      version: record.version + 1,
      status:
        message.status === 'applied'
          ? 'runner_reported_applied'
          : 'runner_unknown',
      runnerOutcome: {
        runId: message.runId,
        bindingDigest: message.bindingDigest,
        status: message.status,
        reportedAt: now,
      },
      audit: [
        ...record.audit,
        {
          event: `runner_${message.status}`,
          actor: `runner:${record.plan.binding.runnerId}`,
          at: now,
        },
      ],
    };
    await this.replace(record, next);
    return { id: next.id, status: next.status };
  }
}
