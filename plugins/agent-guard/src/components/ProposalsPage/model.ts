export type SemanticResult =
  | {
      kind: 'evaluated';
      model: string;
      choice: string;
      choiceConfidence: number;
      choiceProbabilities: Record<string, number>;
      noul: number;
      score: number;
      scoreProbabilities: Record<string, number>;
      scoreLegend: Record<string, string>;
    }
  | { kind: 'unavailable'; reason: string };

export type FrozenSnapshot = {
  digest: string;
  envelope: {
    schemaVersion: number;
    submissionChannel?: 'mcp_action' | 'backstage_rest';
    template: { id: string; version: string; digest: string };
    gitopsTarget: {
      repository: string;
      branch: string;
      path: string;
      publishEnabled?: boolean;
    };
    policyVersion: string;
  };
  files: Array<{ path: string; content: string; sha256: string }>;
};

export type Proposal = {
  id: string;
  declaredIntent: string;
  intentSource: string;
  submissionChannel?: 'mcp_action' | 'backstage_rest';
  templateId: string;
  inputs: {
    serviceName: string;
    requestedOwner: string;
    environment: string;
    description: string;
    replicas?: number;
    schedule?: string;
  };
  requester: string;
  status: string;
  reviewLane: string | null;
  reasonCodes: string[];
  semantic: SemanticResult;
  snapshot?: FrozenSnapshot;
  decision?: {
    decision: 'approve' | 'reject';
    reviewer: string;
    decidedAt: string;
    digest: string;
    comment?: string;
  };
  execution?: {
    state:
      | 'claimed'
      | 'task_started'
      | 'publishing'
      | 'pr_open'
      | 'completed'
      | 'failed';
    claimedAt: string;
    taskId?: string;
    errorCode?: string;
    prUrl?: string;
    prNumber?: number;
  };
  auditTrail?: Array<{
    type: string;
    actor: string;
    at: string;
    digest: string;
    comment?: string;
  }>;
  viewerPermissions: { canReview: boolean; reason: string };
  createdAt: string;
};

export type DeliveryStatus = {
  checkedAt: string;
  github:
    | { state: 'not_published' }
    | { state: 'unavailable' | 'source_mismatch'; reason: string }
    | { state: 'open' | 'closed_unmerged'; url: string }
    | {
        state: 'merged';
        url: string;
        mergedAt: string;
        mergeCommitSha: string;
        approvedFilesMatch: boolean;
      };
  argoCd:
    | { state: 'not_checked' | 'not_configured' }
    | { state: 'unavailable' | 'source_mismatch'; reason: string }
    | {
        state: 'observed';
        applicationName: string;
        applicationUrl: string;
        syncStatus: string;
        healthStatus: string;
        revision?: string;
        includesApprovedMerge: boolean;
        workloadKind: string;
        workloadHealth: string;
        conditions: string[];
      };
  deployed: boolean;
};

export type Tone = 'positive' | 'warning' | 'negative' | 'neutral';

export function humanize(value: string): string {
  return value.replaceAll('_', ' ').replaceAll('-', ' ');
}

export function statusTone(status: string): Tone {
  if (status === 'rejected' || status.endsWith('failed')) return 'negative';
  if (status === 'needs_clarification') return 'warning';
  // A PR or completed render is not a verified deployment.
  return 'neutral';
}

export function submissionLabel(
  channel: Proposal['submissionChannel'],
): string {
  if (channel === 'mcp_action') return 'MCP action (backend-recorded)';
  if (channel === 'backstage_rest') return 'Backstage REST (backend-recorded)';
  return 'Unknown (historical proposal)';
}

export function intentSourceLabel(source: Proposal['intentSource']): string {
  if (source === 'agent_supplied') return 'Agent-supplied statement';
  if (source === 'authenticated_user_submitted') {
    return 'Submitted with authenticated Backstage user credentials';
  }
  return humanize(source);
}
