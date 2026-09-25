# Backstage Agent Guard

A local portfolio project for governing an agent's service-deployment proposal before any GitOps change. Codex uses Backstage's official MCP Actions endpoint; Agent Guard validates the proposal, asks Jev to compare it with the agent-declared intent, and applies deterministic review routing. Backstage hosts the proposal and approval UI; an opt-in Scaffolder action can open a GitOps PR. A separate local Kind/Argo CD setup watches the merged GitOps branch.

## Current implementation

- Official Backstage starter with the New Frontend System, Catalog, Scaffolder, and MCP Actions.
- Exactly two agent-visible MCP tools: `agent-guard.submit-proposal` and `agent-guard.get-proposal-status`. Other action sources, including Scaffolder, are excluded.
- A backend plugin validates three staging-only template choices and narrow parameters, verifies the requested owner exists in the Catalog, derives the requester from a Backstage **user** principal, stores proposals in SQLite, calls Jev when `TYPESAFE_API_KEY` is configured, and keeps Jev output separate from deterministic review status.
- An Agent Guard review page lists proposals visible to the requester or owning team. It displays Jev Choice, Noul, and Score, the exact rendered files, per-file hashes, the canonical approval digest, policy reasons, and audit history.
- The review workspace has a searchable proposal queue, a manual **New proposal** form, intent-versus-change comparison, accessible Jev gauges, a digest-bound decision panel, readable file previews, and a segmented read-only delivery track. The form offers only the three trusted staging templates, suggests owner groups from Catalog, and submits through the authenticated Agent Guard REST endpoint; it cannot run Scaffolder. The track distinguishes approval, PR merge, Argo CD sync, and verified deployment; an open PR is never shown as deployed.
- New proposals record the backend entry point (`mcp_action` for the registered Agent Guard action or `backstage_rest` for its HTTP endpoint) in the proposal, submitted audit event, and version-2 approval snapshot. The backend labels MCP intent `agent_supplied` and REST intent `authenticated_user_submitted`; the latter means a Backstage user credential submitted it, **not** proof that a human personally typed it. Callers cannot set provenance in proposal input. Older frozen snapshots retain their original provenance and digests.
- Three platform-owned Scaffolder templates render fixed Kubernetes manifests for an internal Node.js API, an internal FastAPI service, and a CronJob. API replica count is a narrow, reviewable input limited to `1` or `2`; the CronJob does not expose Deployment replicas. Their images are pinned to immutable public digests.
- New proposals freeze the exact rendered output and bind intent, provenance, requester, template/version, validated inputs, GitOps target, file hashes, and policy version into a SHA-256 approval digest. Only a **different** authenticated member of the requested owner group can approve or reject the matching pending snapshot, even for a same-team request.
- Opt-in GitHub sign-in uses immutable GitHub user IDs mapped to distinct Backstage catalog users. The secure mode does not register the guest auth provider. The default guest mode remains for local proposal/UI exploration but cannot satisfy two-person review.
- A temporary permission policy denies ordinary users Scaffolder task creation, inline dry-runs, and action execution. Backstage service principals can still call Scaffolder; the GitOps publisher independently validates the approved snapshot, exact rendered file hashes, and a one-time task-bound execution claim. Direct `/create` and REST execution must not bypass review.
- Approval starts one internal service-to-service Scaffolder task. Without GitOps configuration, it renders files only. With GitOps configuration, the guarded action uses Backstage's GitHub PR publisher to open a PR in a backend-owned repository and records the URL in Agent Guard. A failed or ambiguous dispatch/publish is not automatically retried.
- A separate read-only delivery endpoint, visible only to authorized proposal viewers, checks the GitHub PR, exact files at its merge commit, the shared Argo CD staging Application revision/sync/health, and the proposal's workload health. The Application revision may be newer than a proposal's merge; the observer verifies that it contains that merge before claiming delivery. The proposal page displays observations without rewriting recorded Scaffolder state or granting deployment access. Missing credentials or connectivity show an unavailable state.
- The opt-in GitOps configuration has one platform-owned Argo CD Application watching `apps/staging/` recursively. A newly merged Agent Guard service folder is reconciled without creating another Application. A narrow Catalog provider checks the configured private GitOps repository's `main` branch every minute for `apps/staging/*/catalog-info.yaml`, so newly merged services are also registered without editing Backstage configuration for each name. GitHub failures leave existing Catalog registrations intact.
- The opt-in Kubernetes tab connects to the local Kind staging namespace using a namespace-scoped ServiceAccount that can only get/list/watch runtime objects. It cannot deploy, delete, exec into Pods, or read Secrets.

The guarded publisher opened a real private GitHub PR (#1), and its four files matched the approved snapshot hashes. A human merged it on 2026-09-24 at commit `003d35d51920dd44c2b05e5cbaf4c6182edb4447`. A separate `agent-guard` Kind cluster runs Argo CD v3.5.3; its Application reports `Synced` and `Healthy` at that commit. Kubernetes shows one available Node.js Deployment, one ready Pod, and an internal ClusterIP Service. An HTTP request through the Service returned `200` with `{"service":"gitops-pr-demo-api","ok":true}`. The delivery observer passed a live read-only test against this private PR and Argo CD. In a signed-in browser, the new panel showed the merged commit, matching approved files, `Synced`/`Healthy`, and “Verified at the approved merge commit.” With only the local Argo CD port-forward stopped, Refresh showed `unavailable (request_failed)` and “Not verified as deployed”; the port-forward was then restored. Its recorded proposal state remains `pr_open` because that records the Scaffolder handoff, while the observation panel reports merge/deployment separately. A PR, even if open, is not a deployment. Old approvals cannot authorize new side effects: previously approved or pending proposals remain inert and must be resubmitted under the current digest/policy version. When Jev is not configured, the proposal becomes `needs_clarification` and cannot be approved.

A first live approval exposed a Scaffolder behavior that mocked action tests missed: a step-level `if` referring to task secrets evaluated false before the guarded publisher ran. The templates now always reach that action; it does nothing for render-only tasks and still requires the live task-bound claim before any GitHub write. The previously approved task was not retried; a new proposal produced PR #1.

## Run locally

Requirements: Node.js 22 or 24 and enough memory/disk for Backstage; Docker is needed for the separate Kind deployment. The repository includes Yarn 4; Corepack is not required if you call its bundled entrypoint.

```sh
node .yarn/releases/yarn-4.13.0.cjs install
node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start
```

Open `http://localhost:3000/agent-guard`. The MCP endpoint is `http://localhost:7007/api/mcp-actions/v1`. For real Jev evaluations, set `TYPESAFE_API_KEY` in the backend process environment. Keep it out of committed files and screenshots.

To submit without Codex, sign in to Backstage, select **Agent Guard → New proposal**, choose one of the three trusted templates, and enter declared intent, service name, an existing `group:default/...` owner, and a description. API templates also accept `1` or `2` replicas; the worker instead needs a five-field cron schedule. Submitting runs validation and Jev, then creates a frozen proposal for a _different_ owner-group member to review. It never starts Scaffolder or opens a PR by itself. The Catalog `/create` page remains for viewing platform templates, not bypassing Agent Guard approval.

The default `guest-demo` mode uses one shared identity. It can submit and inspect proposals, but **cannot approve its own proposal** under the distinct-reviewer policy. Static service tokens are intentionally not accepted by the proposal backend as developer identities.

### Try distinct GitHub identities locally

1. Create a GitHub OAuth App with homepage `http://localhost:3000` and callback `http://localhost:7007/api/auth/github/handler/frame`. Put its `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` in your ignored `.env` file.
2. Copy [examples/github-users.example.yaml](examples/github-users.example.yaml) to the ignored `examples/github-users.yaml` and replace each `github.com/user-id` placeholder with the account's immutable GitHub `node_id` (from `https://api.github.com/users/<login>`). Use **two different accounts**: one requester and one reviewer. The reviewer must belong to the requested owner group. Treat the local catalog file as platform-owned, not agent-writable.
3. Start with `AGENT_GUARD_AUTH_MODE=github node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start --config ../../app-config.yaml --config ../../app-config.github.yaml`, then sign in through GitHub. The paths are relative to each workspace package because `repo start` forwards them to both app and backend. The overlay selects GitHub sign-in and disables the guest provider; a mode/config mismatch fails instead of falling back to shared guest login.
4. Submit a proposal as `developer`. The same user must receive HTTP 403 on the decision endpoint; sign in as the distinct `reviewer` to approve or reject.

The review endpoint checks distinct Backstage user identities and owner-group membership, not cryptographic proof that a particular browser click was human. An agent holding a **reviewer's** credential could still act as that reviewer. Do not give the agent reviewer credentials. GitHub OAuth setup and a two-account live approval have not been exercised by automated tests; those tests use mocked users.

### Opt in to GitOps PR publishing

1. Create a separate GitHub repository named `backstage-agent-guard-gitops` under your account, with a `main` branch. The repository and access token must be owned/configured by the platform operator, not supplied by the agent. Do not put the token in templates or proposals.
2. Add `GITHUB_TOKEN=<token>` and `AGENT_GUARD_GITOPS_REPO_URL=github.com?owner=<your-github-owner>&repo=backstage-agent-guard-gitops` to your ignored `.env` file. Use a GitHub token with the repository permissions needed to create branches/contents and pull requests. Keep `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`, and `TYPESAFE_API_KEY` there too if using the real two-person/Jev path.
3. Start in GitHub auth mode with the opt-in GitHub integration overlay:

```sh
AGENT_GUARD_AUTH_MODE=github node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start --config ../../app-config.yaml --config ../../app-config.github.yaml --config ../../app-config.gitops.yaml
```

For a local test when GitHub CLI is already authenticated with repository access, you can keep the GitHub token out of `.env` and supply it only to this server process:

```sh
AGENT_GUARD_AUTH_MODE=github \
AGENT_GUARD_GITOPS_REPO_URL='github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops' \
GITHUB_TOKEN="$(gh auth token)" \
node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start \
  --config ../../app-config.yaml \
  --config ../../app-config.github.yaml \
  --config ../../app-config.gitops.yaml
```

4. Submit a **new** proposal, review the frozen repository/path/files/digest in Backstage, and approve it from the distinct owner account. Refresh Agent Guard to see `pr_open` and its PR link. Merge the PR yourself as a separate release decision; Backstage approval never merges it.

Do not enable the GitOps URL without also loading `app-config.gitops.yaml` and supplying a valid token: the action would claim publishing and then fail at GitHub. If GitHub responds but the callback to Agent Guard is lost, the state can remain `publishing`; inspect the Scaffolder task and remote repository before any manual recovery. The claim is stored only as a hash in Agent Guard and is never returned in proposal views. The internal publish endpoints require Backstage service credentials plus that claim; they are not agent MCP tools.

### Local GitOps cluster

The platform-owned bootstrap manifests and repeatable commands are in [deploy/README.md](deploy/README.md). They use an isolated Kind cluster, a pinned Argo CD install, and a repo-scoped **read-only** GitHub deploy key. Argo CD follows only `main`; the Scaffolder PR branch is deliberately outside its source. Do not put the SSH private key, GitHub token, or Argo CD admin password in this repository.

PR #1 was reopened and human-merged as a separate release decision. The original Application reconciled `apps/staging/gitops-pr-demo-api` from `main`; sync, health, Deployment availability, Pod readiness, and Service HTTP response were checked separately. Before deploying additional services, migrate the Application to the shared `apps/staging/` directory-recursion configuration in [deploy/README.md](deploy/README.md). During bootstrap, Argo CD's standalone `Healthy` field was **not** proof of a deployment while sync was `Unknown` with a comparison error. The restricted Argo CD project cannot create Namespace resources; the platform operator created only the `staging` namespace before sync.

### See deployment status in Backstage

The local setup has an ignored, mode-`600` `.env.delivery.local` containing a 30-day Argo CD token restricted to `applications get` on `agent-guard-staging/gitops-pr-demo-api`, the loopback API URL, and its public TLS certificate. The token is not an Argo admin credential. Keep this file private; rotate the token when it expires or when recreating the cluster. Do not paste it into chat or commit it.

Keep these two processes running in **separate terminals outside Codex**. First, connect only to the local Argo CD service:

```sh
kubectl --context kind-agent-guard -n argocd port-forward --address 127.0.0.1 svc/argocd-server 8082:443
```

Then start Backstage from this directory with GitHub sign-in and both ignored env files:

```sh
AGENT_GUARD_AUTH_MODE=github \
AGENT_GUARD_GITOPS_REPO_URL='github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops' \
GITHUB_TOKEN="$(gh auth token)" \
node --env-file-if-exists=.env --env-file-if-exists=.env.delivery.local \
  .yarn/releases/yarn-4.13.0.cjs start \
  --config ../../app-config.yaml \
  --config ../../app-config.github.yaml \
  --config ../../app-config.gitops.yaml
```

Sign in at `http://localhost:3000/agent-guard`, open `gitops-pr-demo-api`, and press Refresh. The recorded `pr_open` state and the read-only merged/deployed observation are intentionally distinct. If the port-forward stops, the panel must say Argo CD is unavailable, not that the deployment succeeded. After the documented Application migration, this one shared Application can observe each approved service's individual workload; an Application revision may include later merged services, so the observer checks that it contains the proposal's approved merge.

### See Kubernetes resources in Backstage

Apply the local, namespace-scoped read-only role once:

```sh
kubectl --context kind-agent-guard apply \
  -f deploy/kubernetes/backstage-kubernetes-reader.yaml
```

Then restart Backstage with the Kubernetes overlay. The command derives the Kind API URL and CA from the local kubeconfig and obtains a short-lived ServiceAccount token without writing it to `.env` or printing it. Keep the token out of chat and source control.

```sh
AGENT_GUARD_AUTH_MODE=github \
AGENT_GUARD_GITOPS_REPO_URL='github.com?owner=<your-github-owner>&repo=backstage-agent-guard-gitops' \
GITHUB_TOKEN="$(gh auth token)" \
AGENT_GUARD_K8S_URL="$(kubectl --context kind-agent-guard config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')" \
AGENT_GUARD_K8S_CA_DATA="$(kubectl --context kind-agent-guard config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')" \
AGENT_GUARD_K8S_TOKEN="$(kubectl --context kind-agent-guard -n staging create token backstage-kubernetes-reader --duration=24h)" \
node --env-file-if-exists=.env --env-file-if-exists=.env.delivery.local \
  .yarn/releases/yarn-4.13.0.cjs start \
  --config ../../app-config.yaml \
  --config ../../app-config.github.yaml \
  --config ../../app-config.gitops.yaml \
  --config ../../app-config.kubernetes.yaml
```

Open a merged service in Catalog and choose **Kubernetes**. The resource labels and Catalog annotations generated for new services make the tab show only that service's staging objects. Existing demo objects have been labelled in the local Kind cluster. If the 24-hour token expires, restart with the same command.

## Verify

```sh
node .yarn/releases/yarn-4.13.0.cjs tsc
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-agent-guard-backend test --watch=false --runInBand
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-scaffolder-backend-module-agent-guard test --watch=false --runInBand
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-permission-backend-module-agent-guard test --watch=false
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-agent-guard test --watch=false
```

The backend integration tests bind a local port; run them in an environment that permits loopback listening. The permission-module suite starts the real Scaffolder and permission HTTP routes with the Agent Guard policy and mocked authenticated Backstage users for both demo accounts. It verifies that direct task creation and inline dry-run return `403` without creating a task, and owner-scoped task lists return `200`. A separate local no-step task created by a service is visible to that service but hidden from a browser user's list and detail request. These tests do not exercise live GitHub OAuth or contact GitHub. Agent Guard's service-created tasks are not attributed to a browser user, so the proposal UI shows their task ID and handoff state instead of linking to an inaccessible Scaffolder task-detail page.

With the port-forward running and GitHub CLI authenticated, the opt-in live read-only check is:

```sh
AGENT_GUARD_LIVE_DELIVERY=1 GITHUB_TOKEN="$(gh auth token)" \
node --env-file-if-exists=.env.delivery.local .yarn/releases/yarn-4.13.0.cjs \
  workspace @internal/backstage-plugin-agent-guard-backend test \
  --watch=false --runInBand src/deliveryStatus.test.ts
```

## Next implementation slices

1. Record the live two-account GitHub sign-in/approval evidence and verify the Codex MCP OAuth caller was attributed to the requester identity.
2. Optionally repeat the direct REST/dry-run denial against the live GitHub-authenticated app without sharing browser tokens. The `/create` UI gate and local HTTP integration tests now pass; the publisher is not exposed through MCP.
3. Add a viewer-scoped task-detail/log view inside Agent Guard if richer task diagnostics are needed; do not grant browser users blanket access to service-created Scaffolder tasks.
4. Exercise a second service through PR merge, shared Argo CD sync, and automatic Catalog discovery. Add a viewer-scoped task-detail/log view if richer diagnostics are needed. A Catalog entry alone is not deployment evidence.

The [project skill](.agents/skills/backstage-agent-guard/SKILL.md) contains the full agreed workflow and boundaries.

The [portfolio demo guide](docs/portfolio-demo.md) contains an architecture diagram, observed evidence, remaining live verification, and a blog outline.
