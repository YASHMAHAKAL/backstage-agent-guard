# Rizz.AI cloud extension — Phase 0 inventory and decisions

Inventory date: 2026-09-26. Scope: read-only inspection and a local planning artifact. No cloud resources provisioned, Terraform initialized/applied, deployments changed, secrets read, application source modified, or external branches/PRs created.

**Status: repository and Kind inventory complete; user confirms no Rizz.AI provisioning, selects us-east-1 and a short-lived verification demo. Live AWS preflight and remaining decisions are pending.** This is not an approval to provision or a claim that Rizz.AI is currently deployed on AWS.

## 1. Evidence and inspection boundaries

| Area                    | Evidence inspected                                                                 | Result                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Platform checkout       | Current branch/commit, schemas, snapshots, provider, observer, bootstrap manifests | Branch `main`, commit `7f78bc0`; cloud skill edits remain uncommitted                                                  |
| Application source      | GitHub API, pinned source commit `82ee13a71c445255736857b79f4a459e0cf53649`        | Existing public application, default branch `master`; no local checkout located in the inspected top-level directories |
| GitOps source           | GitHub API, `main` at `1eb7b80b4d973eddbd7b49e84256dcee6c7b44f5`                   | Private repo containing the two current demo workloads                                                                 |
| Kind                    | Explicit `kind-agent-guard` context; read-only workload/Application queries        | Both demo Deployments 1/1 ready; shared Argo Application Synced/Healthy                                                |
| AWS access              | Default CLI STS authentication check; account/identity details suppressed          | Authentication succeeds; association with Rizz.AI's intended account is unconfirmed                                    |
| AWS resources/state     | Not inspected in an unconfirmed account/profile                                    | Unknown; requires the intended profile and state location                                                              |
| GitHub controls         | Branch metadata and repository rulesets                                            | Both tracked branches report unprotected; both repositories return no repository rulesets                              |
| GitHub workflow history | Last three Rizz.AI deployment runs                                                 | Two failed November 29, 2025; one successful November 27, 2025. Cause and existing infrastructure not inferred         |

Network restrictions initially blocked read-only access; successful checks were retried with the available approval mechanism. No profile was switched, kubeconfig rewritten, or AWS secret value queried. Existing ignored auth mappings were used only to verify local group relationships; personal identifiers and credentials are excluded from this report.

Source: [Rizz.AI](https://github.com/YASHMAHAKAL/Rizz.AI). The private GitOps repository remains private; this document does not reproduce its credentials.

User clarification during inventory: keep `us-east-1`; provision only for project verification and take it down after successful confirmation; Rizz.AI has not been provisioned. Treat the no-existing-deployment statement as user-reported, not a live AWS scan. Proposed approach is a fresh staging foundation after account/profile confirmation and a scoped collision check. The old successful workflow does not override the user's current statement.

## 2. Existing platform: preserve and extend

Verified code supports the three local IDs `nodejs-api`, `fastapi-api`, and `scheduled-worker`; no `deploy-rizz-ai` template or cloud release contract exists yet.

| Existing mechanism                                                          | Inspected location                                                                 | Cloud implication                                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Strict proposal schema; staging literal; API replicas 1–2                   | `plugins/agent-guard-backend/src/domain.ts`                                        | Add a discriminated cloud contract; do not add unrestricted fields or conflate targets           |
| Deterministic fixed-image rendering and snapshots                           | `plugins/agent-guard-backend/src/snapshot.ts`                                      | Add a separate trusted paired-release renderer; retain old snapshot destinations/integrity       |
| Atomic review/execution claims and digest checks                            | `plugins/agent-guard-backend/src/services/ProposalService.ts`                      | Reuse governance after validating update/concurrency requirements                                |
| Three protected local templates                                             | `catalog/templates/`                                                               | Keep existing local behavior; register the cloud recipe only with its backend support            |
| Merged catalog discovery at `main/apps/staging/*/catalog-info.yaml`         | `plugins/agent-guard-backend/src/gitopsCatalogProvider.ts`                         | Add independent Rizz source descriptors; do not repoint or loosen existing provider patterns     |
| One shared local Argo Application/project/path                              | `deploy/argocd/staging-application.yaml`                                           | Create separate EKS Application/project and backend target mapping                               |
| Observer checks merge-time file hashes, merge ancestry, one workload health | `plugins/agent-guard-backend/src/deliveryStatus.ts`                                | Cloud needs actual synced-revision file validation plus two workload rollouts and smoke evidence |
| Kind service-account reader, namespace scoped, TLS verified                 | `app-config.kubernetes.yaml`, `deploy/kubernetes/backstage-kubernetes-reader.yaml` | Keep local token isolated; design renewable EKS read-only authentication                         |
| Local database                                                              | `app-config.yaml`                                                                  | Local portal may remain SQLite; hosted portal requires a separate durable PostgreSQL milestone   |

The existing observer can accept a newer shared Argo revision that includes an older merge. It does not currently compare approved files again at that newer revision. Thus later edits to the same app need stronger verification before this observer is reused for cloud releases. This is an inventory finding, not a fix made in Phase 0.

Live Kind observations: `gitops-pr-demo-api` and `fastapi-catalog-demo-api` have ready Pods and internal ClusterIP Services. Argo Application `gitops-pr-demo-api` tracks `apps/staging`, recursively, excluding catalog descriptors and old kustomization files. Its automation has self-heal enabled and prune disabled. Do not replace it with the cloud Application or turn on pruning without a separate reviewed migration.

Local authenticated requester/reviewer mappings both belong to `payments-team`; `platform-team` exists but has no real mapped members in the inspected files. Platform-only infrastructure review needs an explicit membership decision. Guest membership does not make guest approval valid. We inspected code/configuration, not a new live OAuth or approval round-trip.

## 3. Application readiness inventory

| Concern               | Current evidence                                                                       | Required Phase 1 change                                                               |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Frontend              | React 19, TypeScript, Vite 7, nginx; `/api` proxy to backend                           | Preserve source and same-origin routing; test production build and container behavior |
| Backend               | Express 4; three POST endpoints; Gemini through `GEN_AI_KEY`                           | Health/config-readiness endpoints; explicit validated configuration                   |
| Gemini                | Backend legacy SDK `@google/generative-ai` 0.11 range; hardcoded preview model         | Supported SDK and model configuration after current compatibility review              |
| Build reproducibility | Dockerfiles use `npm install`; frontend lock exists, backend lock absent               | Backend lockfile and reproducible installs; supported pinned runtime/images           |
| Build context         | Frontend `.dockerignore` excludes `.env`; backend has none in inspected tree           | Exclude secrets, dependencies, Git data and build artifacts in both contexts          |
| Runtime security      | No Dockerfile non-root user; nginx listens on 80                                       | Compatible non-root execution/ports and tested filesystem permissions                 |
| Kubernetes            | `latest`, pull policy Never; no namespace, probes, resources or security context       | Dedicated cloud manifests with digest refs and staging controls                       |
| Exposure              | Frontend LoadBalancer Service; backend defaults to ClusterIP                           | Reviewed ALB HTTPS frontend recipe; backend remains ClusterIP                         |
| Abuse/cost controls   | No server auth/rate/concurrency limit in inspected server; 10 MB JSON limit            | Explicit access strategy and bounded request/provider usage before public exposure    |
| Usage credits         | Frontend useState starts at 5                                                          | Do not treat browser credits as enforceable quota                                     |
| Failures              | Missing key logs error but server continues; frontend returns friendly fallback values | Accurate readiness, typed failure handling, timeouts and sanitized observability      |
| Tests                 | No test scripts in either package manifest; no test files found in source tree         | API/routing/config/error tests and provider-mocked smoke tests                        |
| Storage               | localStorage and React/in-memory state                                                 | No application database needed for the initial release                                |
| Catalog/operations    | No catalog descriptor or release contract found                                        | System/components/API/docs, build/release metadata and operational links              |

No Gemini request was made. No image was built or pushed. No source dependency was installed or upgraded.

## 4. Current CI and Terraform: migration risks

Inspected [deployment workflow](https://github.com/YASHMAHAKAL/Rizz.AI/blob/82ee13a71c445255736857b79f4a459e0cf53649/.github/workflows/deploy.yml):

- Runs on `main`/`master` push or workflow dispatch, selecting a GitHub environment named `production`.
- Uses long-lived AWS secret credentials rather than OIDC.
- Builds/pushes both SHA-tagged images before Terraform creates their repositories. First bootstrap is not handled by that order.
- Uses Terraform 1.5.7, plans and automatically applies during the same app workflow.
- Rewrites kubeconfig, creates the Gemini Kubernetes Secret and deploys directly with kubectl.
- No test/scan/paired-release publication steps or GitOps approval boundary are present in this workflow.

The environment name does not prove effective review protection. We have not inspected its environment rules or secret configuration.

Inspected Terraform declares:

| Item            | Source configuration                                                          | Decision needed                                                                       |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Region          | `us-east-1`                                                                   | Confirm or select another region; changing region can mean replacement, not migration |
| State           | No backend block in inspected roots; workflow init supplies no backend config | Find actual state; do not infer that no state/resources exist                         |
| Provider        | AWS `~> 5.0`; lock selects `5.100.0`                                          | Compatibility review and explicit upgrade strategy                                    |
| EKS module      | `~> 20.0`, cluster version 1.29                                               | Supported Kubernetes/add-on/module combination before apply                           |
| Nodes           | One desired `t3.medium`, min 1/max 2                                          | Capacity measurement; staging only, not HA                                            |
| Network         | Two AZs, public/private subnets, single NAT                                   | Confirm egress cost and single-NAT tradeoff                                           |
| Endpoint/access | Public endpoint enabled, creator admin                                        | Constrained access and least-privilege operator/CI roles                              |
| ECR             | Two repositories, mutable tags, scan on push                                  | Pin deployment digests; define immutability, scan gate and retention                  |
| Labels          | Terraform tags say dev; workflow environment says production                  | Normalize explicitly to cloud staging without assuming existing resource intent       |

An ephemeral CI runner with no declared remote state raises lost-state/duplicate-resource risks. A historically successful workflow does not establish present resources; the user reports no provisioning. Preserve the state/collision preflight before applying a fresh root. No Terraform init, refresh, plan, state command, import, or apply was run.

## 5. Ownership and migration decisions

### Accepted from the discussion

| Concern             | Decision                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Existing demo       | Preserve Kind, three local templates, current local history/destinations                                 |
| Cloud scope         | One Rizz.AI staging deployment on EKS                                                                    |
| AWS region          | Keep `us-east-1`                                                                                         |
| Runtime             | Short-lived project verification; user intends teardown after success, not an always-running environment |
| Existing deployment | User reports Rizz.AI is not provisioned; live target-account preflight still pending                     |
| Source ownership    | Existing Rizz.AI repo retains application source; no copying into Backstage                              |
| Foundation          | Terraform in the platform repo, migrated safely if existing resources/state exist                        |
| Delivery            | Dedicated Argo CD in EKS, reconciling the GitOps repo                                                    |
| Application release | Tested pair of frontend/backend immutable digests from one trusted build                                 |
| Gates               | Proposal → distinct Backstage approval → GitOps PR → human merge → deployment                            |
| Agent authority     | Proposal/status only; no approval, apply, merge, sync or direct deployment                               |
| Jev                 | Semantic alignment advisory; deterministic policy owns hard limits/authorization                         |
| Replica limits      | 1–2 for each cloud Deployment; no replicas input for CronJob                                             |
| Portal hosting      | Local initially; hosting it on EKS is a later milestone                                                  |
| Crossplane/database | Deferred until an actual approved resource requirement                                                   |

### Proposed implementation defaults, not user-approved cloud inputs

- Cloud target ID `eks-staging`, namespace `rizz-staging`, Argo Application `rizz-ai-staging`.
- Cloud GitOps path `clusters/eks-staging/apps/rizz-ai`; existing local `apps/staging` stays unchanged.
- Kustomize for Rizz manifests; ALB HTTPS entry point for the frontend and private backend.
- Platform repo owns Terraform, IAM, state bootstrap and network; GitOps owns application manifests; ingress controller owns the ALB it creates. Pin ownership of each add-on installation/upgrade before deploying it.
- OIDC app-build role restricted to publishing approved ECR repositories; separate infrastructure identity; restricted secret-operator and read-only portal identities.
- For initial infrastructure gates, a reviewed operator-run saved-plan apply is a possible fallback if enforceable private GitHub environment gates are unavailable. No automatic-apply fallback.

### Pending user decisions

| Decision                 | Needed answer                                                                                       | Blocks                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Intended AWS identity    | CLI profile and confirmation it is the target account; no keys/account IDs needed in committed docs | Safe live AWS resource inventory                      |
| Existing resources/state | User reports none; confirm no conflicting named resources/state in the intended account             | Safe fresh foundation                                 |
| Spend                    | Numerical maximum budget; runtime is already confirmed as a short verification demo                 | Sizing/egress/provisioning authorization              |
| App exposure             | Domain you control and HTTPS plan; desired audience/access control                                  | Public-ingress recipe and certificate/DNS             |
| Review identities        | App owner group and actual platform-reviewer membership                                             | Authorized cloud/infrastructure review                |
| CI/merge gates           | Available GitHub branch/environment controls and who may merge                                      | Enforceable two-gate release and plan/apply workflows |

AWS resource discovery remains pending these identity decisions; we did not enumerate unrelated resources using the current default credentials. Missing state must be treated as a reconciliation/import problem, not an instruction to start again.

## 6. Preliminary cost model — illustrative, not a quote or spending cap

Before provisioning, recalculate for the chosen region/SKUs and a measured worker capacity. Current official sources provide the following reference rates:

| Component         | Reference assumption                                                                                         | 730-hour illustration |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- |
| EKS control plane | Standard-support cluster, $0.10/hour                                                                         | $73.00                |
| Single NAT        | Published US East (Ohio) example: $0.045/hour, data processing extra                                         | $32.85                |
| ALB base          | Published pricing example: $0.0225/hour, LCU extra                                                           | $16.43                |
| Public IPv4       | $0.005/address/hour; assume NAT + two ALB addresses                                                          | $10.95                |
| Worker            | Planning allowance $40–70/month, SKU not selected/quoted                                                     | $40–70                |
| Other services    | Planning allowance $10–30/month for small storage/logging/registry/secret footprint; not a measured forecast | $10–30                |

The first four assumptions total approximately $133.23/month before workers, LCU/traffic and ancillary services. With the provisional allowances, use roughly **$180–250/month as an initial planning range**, not an upper bound. This is not a us-east-1 SKU quote; NAT/ALB example rates must be checked for the selected region. Additional nodes, larger monitoring stacks, CPU-credit usage, data transfer, NAT processing, endpoint/KMS charges, retention and taxes can increase the bill. Gemini usage and domain registration are separate. No free-tier or credit eligibility is assumed.

Sources: [EKS pricing](https://aws.amazon.com/eks/pricing/), [VPC pricing including NAT and IPv4](https://aws.amazon.com/vpc/pricing/), [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

Recommendation: develop locally and run a bounded cloud demonstration. Track time from resource creation through verified teardown, including bootstrap/rollout/debugging. Retained registry/state/secret resources can continue billing afterward. Budgets are alerts, not a guaranteed spending cap. Do not automatically destroy resources without explicit scope/authorization.

The user has selected this short-lived approach. For planning only, the illustrative monthly range corresponds to roughly $0.25–0.35/hour of running infrastructure, before variable/excluded charges. This is not a selected-region quote or a total demo promise: setup/debugging time, minimum billing periods, retained resources, domain registration, and provider usage still matter. Agree a numerical budget and verify the actual estimate before creating anything. The user's intention to take it down after success does not authorize a destroy operation in this Phase 0 turn.

## 7. Migration sequence and remaining evidence

1. Confirm intended AWS profile/account and region. Read-only inventory should check Rizz-owned EKS/ECR/VPC/NAT/LB resources, relevant IAM/OIDC metadata, and state-backend metadata without reading secret values. Record access-denied as unknown, not absent.
2. Locate actual Terraform state and ownership. Match resource identifiers privately to the state. Review import/move/backend migration requirements and ensure one Terraform owner; protect state contents and avoid committing identifiers unnecessarily.
3. Establish app readiness locally in the existing app repository. Do not push the current source branch casually: its present workflow can auto-provision/deploy. Source/CI changes require a safe reviewed delivery plan.
4. Prepare separate build and infrastructure workflows; bootstrap ECR/state/trust before a real build push. Retire old direct deployment only when the governed replacement and rollback plan are ready; avoid both kubectl and Argo reconciling the same workloads.
5. Add explicit cloud configuration/recipe/release contract while preserving the local schema, snapshots, catalog discovery and Argo ownership.
6. Review AWS plan and actual estimated cost, obtain provisioning authority, then create/migrate the foundation. No automatic fresh apply where resource/state ownership is unresolved.
7. Run the paired-release approval/PR/merge/deploy path and verify actual synced files, both workloads, and smoke checks. Record evidence and test rollback/unavailable observations.

Phase 0 is ready to hand off application-readiness findings, but its cloud inventory gate is not closed until the pending identity/state/budget decisions are resolved. The next code phase is Phase 1, only on a separately requested implementation turn. This document changes no execution policy or deployment configuration.
