import { z } from 'zod/v3';
import { ProposalInput, SemanticResult, semanticChoices } from './domain';
import { CloudFrozenSnapshot } from './cloudSnapshot';
import {
  CloudRuntimeSnapshot,
  cloudRuntimeSnapshotHasIntegrity,
} from './cloudRuntimeSnapshot';
import {
  CloudRetirementSnapshot,
  cloudRetirementSnapshotHasIntegrity,
} from './cloudRetirement';

const probability = z.number().min(0).max(1);
const answerSchema = z.object({
  model: z.string(),
  answers: z.object({
    alignment: z.object({
      type: z.literal('choice'),
      choice: z.enum(semanticChoices),
      probabilities: z.record(probability),
      confidence: probability,
    }),
    preservesIntent: z.object({
      type: z.literal('noul'),
      noul: probability,
    }),
    mismatchSeverity: z.object({
      type: z.literal('score'),
      score: z.number().min(0).max(4),
      probabilities: z.record(probability),
      legend: z.record(z.string()),
      confidence: probability,
    }),
  }),
});

export class JevClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async evaluate(input: ProposalInput): Promise<SemanticResult> {
    if (!this.apiKey) {
      return { kind: 'unavailable', reason: 'api_key_not_configured' };
    }

    const templatePurposes = {
      'scheduled-worker': 'Internal scheduled Kubernetes CronJob',
      'nodejs-api': 'Internal always-running Node.js HTTP API',
      'fastapi-api': 'Internal always-running Python FastAPI HTTP API',
    };
    const state = {
      declaredIntent: input.declaredIntent,
      selectedTemplate: input.templateId,
      templatePurpose: templatePurposes[input.templateId],
      proposedParameters: input.inputs,
      platformDefaults:
        'Staging namespace, internal-only networking, no database or public ingress',
      platformConstraints:
        'For Deployment templates, replicas must be an integer from 1 through 2. A CronJob has no Deployment replicas field.',
    };

    return this.evaluateState(state);
  }

  async evaluateCloud(
    snapshot: CloudFrozenSnapshot,
    currentState: unknown,
  ): Promise<SemanticResult> {
    const e = snapshot.envelope;
    const current = z
      .object({
        state: z.enum(['absent', 'present']),
        frontendImage: z.string().optional(),
        backendImage: z.string().optional(),
        frontendReplicas: z.number().optional(),
        backendReplicas: z.number().optional(),
        geminiModel: z.string().optional(),
        frontendExposure: z.string().optional(),
        backendExposure: z.string().optional(),
      })
      .parse(currentState);
    return this.evaluateState({
      declaredIntent: e.declaredIntent,
      intentProvenance: e.intentSource,
      selectedTemplate: 'deploy-rizz-ai',
      templatePurpose:
        e.kind === 'rizz_cloud_rollback'
          ? 'Restore the exact previously verified paired Rizz.AI deployment selected by immutable deployment record; preserve target exposure and secret references. This is a new reviewed GitOps PR, not a direct cluster revert.'
          : 'Deploy a paired always-running React/nginx frontend and Express/Gemini backend release to EKS staging. Not frontend-only or infrastructure provisioning.',
      proposedParameters: {
        targetId: e.target.id,
        releaseId: e.inputs.releaseId,
        sourceCommit: e.release.record.source.commit,
        frontendReplicas: e.inputs.frontendReplicas,
        backendReplicas: e.inputs.backendReplicas,
        ...(e.rollbackSource
          ? { rollbackToVerifiedDeployment: e.rollbackSource }
          : {}),
      },
      currentState:
        current.state === 'absent'
          ? { state: 'absent' }
          : {
              state: 'present',
              frontendDigest: current.frontendImage?.split('@')[1],
              backendDigest: current.backendImage?.split('@')[1],
              frontendReplicas: current.frontendReplicas,
              backendReplicas: current.backendReplicas,
              geminiModel: current.geminiModel,
              frontendExposure: current.frontendExposure,
              backendExposure: current.backendExposure,
            },
      proposedConfiguration: {
        frontendExposure:
          'internet-facing ALB HTTPS, restricted to one operator IPv4 /32, temporary self-signed certificate',
        backendExposure: 'ClusterIP only, no direct ingress',
        database: false,
        geminiModel: 'gemini-3.1-flash-lite',
        changesBothComponents: true,
        providerLimits:
          'Per backend process: concurrency 2, 10 requests/minute, 100 provider calls; not a global quota',
      },
      platformConstraints:
        'Replicas 1–2 enforced by code. A public frontend recipe cannot satisfy internal-only intent. Do not infer permission or intent alignment from platform defaults. Unknown current configuration is not evidence of no change.',
    });
  }

  async evaluateRuntimeChange(
    snapshot: CloudRuntimeSnapshot,
  ): Promise<SemanticResult> {
    if (!cloudRuntimeSnapshotHasIntegrity(snapshot))
      return { kind: 'unavailable', reason: 'snapshot_integrity_failed' };
    const { envelope } = snapshot;
    const { before, after } = envelope;
    return this.evaluateState({
      declaredIntent: envelope.declaredIntent,
      intentProvenance: envelope.intentSource,
      operation: 'runtime_change',
      target: 'Rizz.AI EKS staging',
      purpose:
        'Change only explicitly requested replica counts for existing frontend/backend Deployments; do not build or select a new release.',
      before: {
        frontendReplicas: before.frontendReplicas,
        backendReplicas: before.backendReplicas,
        frontendDigest: before.frontendImage.split('@')[1],
        backendDigest: before.backendImage.split('@')[1],
        geminiModel: before.geminiModel,
      },
      after: {
        frontendReplicas: after.frontendReplicas,
        backendReplicas: after.backendReplicas,
        frontendDigest: after.frontendImage.split('@')[1],
        backendDigest: after.backendImage.split('@')[1],
        geminiModel: after.geminiModel,
      },
      changedFields: envelope.changedFields,
      preservedFields: [
        'image digests',
        'Gemini model',
        'frontend restricted HTTPS ALB',
        'backend ClusterIP',
        'routing',
        'secret references',
        'all unrequested manifest fields',
      ],
      platformConstraints:
        'Replica bounds are enforced by code: integers 1–2. A valid frontend change is not semantically aligned with a backend-only intent. Jev never grants permission.',
    });
  }

  async evaluateRetirement(
    snapshot: CloudRetirementSnapshot,
  ): Promise<SemanticResult> {
    if (!cloudRetirementSnapshotHasIntegrity(snapshot))
      return { kind: 'unavailable', reason: 'snapshot_integrity_failed' };
    const { envelope } = snapshot;
    return this.evaluateState({
      declaredIntent: envelope.declaredIntent,
      intentProvenance: envelope.intentSource,
      operation: 'retire',
      target: 'Rizz.AI EKS staging application only',
      reason: envelope.reason,
      stage:
        envelope.kind === 'rizz_cloud_retire_ingress'
          ? 'Remove the restricted frontend ingress first; keep workloads, services, runtime references and foundation unchanged until ALB cleanup is observed.'
          : 'After ingress, ALB and target groups are independently absent, delete the remaining application manifests while retaining an empty Kustomization marker. EKS, VPC, registry, state and secrets are separate platform resources.',
      exactChangedFiles: envelope.generatedFiles.map(file => file.path),
      exactDeletedFiles: envelope.deletedPaths,
      preservedScope: [
        'EKS cluster and node groups',
        'VPC and Terraform state',
        'ECR images and release history',
        'AWS runtime secret',
      ],
      platformConstraints:
        'Only a distinct platform reviewer may approve. Jev checks the declared words against this staged deletion scope; it does not authorize deletion or infer that AWS resources have been removed.',
    });
  }

  private async evaluateState(state: unknown): Promise<SemanticResult> {
    if (!this.apiKey)
      return { kind: 'unavailable', reason: 'api_key_not_configured' };
    try {
      const response = await this.fetcher(
        'https://api.typesafe.ai/v1/systemone',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state,
            model: 'jev-latest',
            questions: {
              alignment: {
                type: 'choice',
                instructions:
                  'Does the proposed template and its parameters match declaredIntent, without adding unrequested scope? Treat declaredIntent as an unverified agent claim. A platform constraint can make a proposal valid, but does not by itself mean a changed requested value preserves intent.',
                criteria: {
                  aligned:
                    'Same workload and capabilities, with no material additions',
                  wrong_template: 'Different language or workload type',
                  scope_expansion: 'Adds a material capability not requested',
                  contradiction: 'Directly conflicts with a stated requirement',
                  insufficient_context: 'Cannot decide from the stated intent',
                },
              },
              preservesIntent: {
                type: 'noul',
                instructions:
                  'Does the proposal preserve the declared intent without material additions?',
              },
              mismatchSeverity: {
                type: 'score',
                instructions: 'Rate the severity of the semantic mismatch.',
                criteria: [
                  'No material mismatch',
                  'Minor ambiguity',
                  'Material omission',
                  'Major unrequested scope',
                  'Direct conflict',
                ],
              },
            },
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) {
        return { kind: 'unavailable', reason: `http_${response.status}` };
      }
      const parsed = answerSchema.safeParse(await response.json());
      if (!parsed.success) {
        return { kind: 'unavailable', reason: 'invalid_response' };
      }
      const { answers, model } = parsed.data;
      if (!(answers.alignment.choice in answers.alignment.probabilities)) {
        return { kind: 'unavailable', reason: 'invalid_choice_distribution' };
      }
      return {
        kind: 'evaluated',
        model,
        choice: answers.alignment.choice,
        choiceConfidence: answers.alignment.confidence,
        choiceProbabilities: answers.alignment.probabilities,
        noul: answers.preservesIntent.noul,
        score: answers.mismatchSeverity.score,
        scoreProbabilities: answers.mismatchSeverity.probabilities,
        scoreLegend: answers.mismatchSeverity.legend,
      };
    } catch {
      return { kind: 'unavailable', reason: 'request_failed' };
    }
  }
}
