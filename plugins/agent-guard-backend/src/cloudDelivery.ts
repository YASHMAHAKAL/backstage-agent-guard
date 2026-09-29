import { z } from 'zod/v3';
import { CloudTarget } from './cloudTarget';
import { cloudSnapshotHasIntegrity } from './cloudSnapshot';
import { cloudRuntimeSnapshotHasIntegrity } from './cloudRuntimeSnapshot';
import { CloudProposalView } from './services/CloudProposalService';
import { AuthenticatedCloudReaders } from './cloudReaders';
import {
  CloudRuntimeReader,
  WorkloadObservation,
  SmokeObservation,
} from './cloudRuntime';
import { readCloudHttpsJson } from './cloudHttps';

type Stage = {
  state: string;
  revision?: string;
  sync?: string;
  health?: string;
};
export interface CloudDeliveryObservation {
  checkedAt: string;
  github: Stage;
  argoCd: Stage;
  workloads: WorkloadObservation;
  smoke: SmokeObservation;
  deployed: boolean;
}
export interface CloudDeliveryReader {
  observe(proposal: CloudProposalView): Promise<CloudDeliveryObservation>;
  observeApplication?(
    target: CloudTarget,
    signal: AbortSignal,
  ): Promise<{ revision: string; sync: string; health: string }>;
}
export function emptyCloudDelivery(
  state = 'not_configured',
): CloudDeliveryObservation {
  return {
    checkedAt: new Date().toISOString(),
    github: { state },
    argoCd: { state: 'not_checked' },
    workloads: { state: 'not_checked' },
    smoke: { state: 'not_checked' },
    deployed: false,
  };
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);

// Authenticated, bounded GETs only. No Argo refresh/sync or GitHub mutation.
export class CloudDeliveryObserver implements CloudDeliveryReader {
  private readonly url: URL;
  private readonly ca?: Buffer;
  constructor(
    private readonly options: {
      readers: Pick<
        AuthenticatedCloudReaders,
        'readPullRequest' | 'isAncestor' | 'readGitopsRevision'
      >;
      argoCdUrl: string;
      argoCdToken: string;
      destinationServer: string;
      argoCdCaBase64?: string;
      argoRead?: (application: string, signal: AbortSignal) => Promise<unknown>;
      timeoutMs?: number;
      runtime?: CloudRuntimeReader;
    },
  ) {
    this.url = new URL(options.argoCdUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(
      this.url.hostname,
    );
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== '/' ||
      (this.url.protocol !== 'https:' &&
        !(local && this.url.protocol === 'http:')) ||
      !options.argoCdToken.trim()
    )
      throw new Error('Explicit private Argo reader configuration required');
    const destination = new URL(options.destinationServer);
    if (
      destination.protocol !== 'https:' ||
      destination.username ||
      destination.password ||
      destination.search ||
      destination.hash ||
      destination.pathname !== '/'
    )
      throw new Error('Invalid pinned Argo destination');
    if (options.argoCdCaBase64) {
      this.ca = Buffer.from(options.argoCdCaBase64, 'base64');
      if (
        this.ca.length > 32768 ||
        !this.ca.toString().includes('-----BEGIN CERTIFICATE-----')
      )
        throw new Error('Invalid Argo CA');
    }
  }

  private async argo(
    application: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.options.argoRead)
      return this.options.argoRead(application, signal);
    const url = new URL(
      `/api/v1/applications/${encodeURIComponent(
        application,
      )}?project=rizz-app`,
      this.url,
    );
    const headers = {
      Authorization: `Bearer ${this.options.argoCdToken}`,
      Accept: 'application/json',
    };
    if (url.protocol === 'https:') {
      return readCloudHttpsJson({
        url,
        signal,
        ca: this.ca?.toString('utf8'),
        token: this.options.argoCdToken,
      });
    }
    // HTTP is restricted to an explicit loopback port-forward; never remote.
    const response = await fetch(url, { headers, signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Argo unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Argo response too large');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async observeApplication(target: CloudTarget, signal: AbortSignal) {
    const source = z
      .object({
        repoURL: z.literal(target.gitopsRepository),
        path: z.literal(target.gitopsPath),
        targetRevision: z.literal(target.gitopsBranch),
      })
      .strict();
    const destination = z
      .object({
        server: z.literal(this.options.destinationServer),
        namespace: z.literal(target.namespace),
      })
      .strict();
    const app = z
      .object({
        metadata: z.object({
          name: z.literal(target.argoApplication),
          namespace: z.literal('argocd'),
        }),
        spec: z.object({
          project: z.literal('rizz-app'),
          source,
          sources: z.undefined().optional(),
          destination,
        }),
        status: z.object({
          sync: z.object({
            status: z.enum(['Synced', 'OutOfSync', 'Unknown']),
            revision: sha,
            comparedTo: z.object({ source, destination }),
          }),
          health: z.object({ status: z.string().min(1).max(100) }),
          conditions: z.array(z.unknown()).length(0).optional(),
        }),
      })
      .parse(await this.argo(target.argoApplication, signal));
    return {
      revision: app.status.sync.revision,
      sync: app.status.sync.status,
      health: app.status.health.status,
    };
  }

  private async matches(
    target: CloudTarget,
    revision: string,
    proposal: CloudProposalView,
    signal: AbortSignal,
  ) {
    const observed = await this.options.readers.readGitopsRevision(
      target,
      revision,
      signal,
    );
    const base = z
      .object({
        revision: z.literal(revision),
        files: z.array(z.object({ name: z.string(), sha256: z.string() })),
      })
      .parse(observed.base);
    const expected = proposal.snapshot.files.map(file => ({
      name: file.path.slice(target.gitopsPath.length + 1),
      sha256: file.sha256,
    }));
    return (
      base.files.length === expected.length &&
      new Set(base.files.map(file => file.name)).size === expected.length &&
      expected.every(file =>
        base.files.some(
          actual => actual.name === file.name && actual.sha256 === file.sha256,
        ),
      )
    );
  }

  async observe(
    proposal: CloudProposalView,
  ): Promise<CloudDeliveryObservation> {
    const result = emptyCloudDelivery('not_published');
    if (
      !(proposal.snapshot.envelope.kind === 'rizz_cloud_runtime_change'
        ? cloudRuntimeSnapshotHasIntegrity(proposal.snapshot)
        : cloudSnapshotHasIntegrity(proposal.snapshot)) ||
      proposal.snapshot.envelope.proposalId !== proposal.id ||
      proposal.snapshot.envelope.requester !== proposal.requester ||
      proposal.decision?.decision !== 'approve' ||
      proposal.decision.digest !== proposal.snapshot.digest ||
      proposal.decision.reviewer === proposal.requester
    ) {
      result.github.state = 'approval_invalid';
      return result;
    }
    if (!proposal.execution?.prNumber) return result;
    const target = proposal.snapshot.envelope.target;
    const repo = target.gitopsRepository.slice(
      'https://github.com/'.length,
      -4,
    );
    if (
      proposal.execution.prUrl !==
      `https://github.com/${repo}/pull/${proposal.execution.prNumber}`
    ) {
      result.github.state = 'source_mismatch';
      return result;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let merged: string;
      try {
        const repository = z.object({ full_name: z.literal(repo) });
        const pr = z
          .object({
            number: z.literal(proposal.execution!.prNumber!),
            html_url: z.literal(proposal.execution!.prUrl!),
            state: z.enum(['open', 'closed']),
            merged: z.boolean(),
            draft: z.boolean(),
            merge_commit_sha: sha.nullable(),
            base: z.object({
              ref: z.literal(target.gitopsBranch),
              repo: repository,
            }),
            head: z.object({
              ref: z.literal(`agent-guard-cloud/${proposal.id}`),
              repo: repository,
            }),
          })
          .parse(
            await this.options.readers.readPullRequest(
              target,
              proposal.execution!.prNumber!,
              controller.signal,
            ),
          );
        if (pr.state === 'open') {
          result.github.state = pr.draft ? 'draft' : 'open';
          return;
        }
        if (!pr.merged || !pr.merge_commit_sha) {
          result.github.state = 'closed_unmerged';
          return;
        }
        merged = pr.merge_commit_sha;
        result.github = { state: 'merged', revision: merged };
        if (
          !(await this.matches(target, merged, proposal, controller.signal))
        ) {
          result.github.state = 'approved_files_mismatch';
          return;
        }
        result.github.state = 'merged_files_match';
      } catch {
        result.github.state = 'unavailable_or_invalid';
        return;
      }
      result.argoCd = { state: 'unavailable_or_invalid' };
      try {
        const source = z
          .object({
            repoURL: z.literal(target.gitopsRepository),
            path: z.literal(target.gitopsPath),
            targetRevision: z.literal(target.gitopsBranch),
          })
          .strict();
        const destination = z
          .object({
            server: z.literal(this.options.destinationServer),
            namespace: z.literal(target.namespace),
          })
          .strict();
        const app = z
          .object({
            metadata: z.object({
              name: z.literal(target.argoApplication),
              namespace: z.literal('argocd'),
            }),
            spec: z.object({
              project: z.literal('rizz-app'),
              source,
              sources: z.undefined().optional(),
              destination,
            }),
            status: z.object({
              sync: z.object({
                status: z.enum(['Synced', 'OutOfSync', 'Unknown']),
                revision: sha,
                comparedTo: z.object({ source, destination }),
              }),
              health: z.object({ status: z.string().min(1).max(100) }),
              conditions: z.array(z.unknown()).length(0).optional(),
            }),
          })
          .parse(await this.argo(target.argoApplication, controller.signal));
        const revision = app.status.sync.revision;
        result.argoCd = {
          state: 'observed',
          revision,
          sync: app.status.sync.status,
          health: app.status.health.status,
        };
        if (
          !(await this.options.readers.isAncestor(
            target,
            merged,
            revision,
            controller.signal,
          ))
        ) {
          result.argoCd.state = 'revision_unrelated';
          return;
        }
        if (
          !(await this.matches(target, revision, proposal, controller.signal))
        ) {
          result.argoCd.state = 'approved_files_mismatch';
          return;
        }
        result.argoCd.state =
          app.status.sync.status === 'Synced' &&
          app.status.health.status === 'Healthy'
            ? 'synced_files_match'
            : 'not_ready';
        if (result.argoCd.state !== 'synced_files_match') return;
        if (!this.options.runtime) {
          result.workloads.state = 'not_configured';
          result.smoke.state = 'not_configured';
          return;
        }
        const runtime = await this.options.runtime.observe(
          proposal.snapshot,
          controller.signal,
        );
        result.workloads = runtime.workloads;
        result.smoke = runtime.smoke;
        // Recheck the Argo source/destination/revision after live rollout/smoke
        // reads. An application update during observation invalidates the result.
        if (
          runtime.workloads.state === 'verified' &&
          runtime.smoke.state === 'verified'
        ) {
          const finalApp = z
            .object({
              metadata: z.object({
                name: z.literal(target.argoApplication),
                namespace: z.literal('argocd'),
              }),
              spec: z.object({
                project: z.literal('rizz-app'),
                source,
                sources: z.undefined().optional(),
                destination,
              }),
              status: z.object({
                sync: z.object({
                  status: z.literal('Synced'),
                  revision: z.literal(revision),
                  comparedTo: z.object({ source, destination }),
                }),
                health: z.object({ status: z.literal('Healthy') }),
                conditions: z.array(z.unknown()).length(0).optional(),
              }),
            })
            .safeParse(
              await this.argo(target.argoApplication, controller.signal),
            );
          if (!finalApp.success) {
            result.argoCd.state = 'changed_during_observation';
            return;
          }
          result.deployed = true;
        }
      } catch {
        result.argoCd = { state: 'unavailable_or_invalid' };
        result.deployed = false;
      }
    };
    try {
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Observation timeout'));
          }, this.options.timeoutMs ?? 45000);
        }),
      ]);
    } catch {
      // No retained green result after a timed-out or incomplete observation.
      result.github = { state: 'unavailable_or_invalid' };
      result.argoCd = { state: 'not_checked' };
      result.workloads = { state: 'not_checked' };
      result.smoke = { state: 'not_checked' };
      result.deployed = false;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    // A misbehaving injected adapter may resolve after the deadline; return a copy.
    return { ...structuredClone(result), checkedAt: new Date().toISOString() };
  }
}
