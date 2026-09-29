# Rizz.AI lifecycle IDP product contract

## Scope and precedence

The user accepted a portfolio platform engineering project managing the existing Rizz.AI application through its lifecycle. This reference supersedes earlier cloud guidance that treated a single deployment template as the full product or infrastructure controls as optional. Pair it with `rizz-idp-terraform.md` and `rizz-idp-delivery.md`. Inspect code and live configuration before stating that any capability exists.

Required: Rizz.AI Control Center, real catalog relationships, verified release selection, deploy/runtime-change/rollback/retirement operations, application/platform roles, exact change review, operational visibility, service-readiness checks, runbooks, and governed Terraform controls. Preserve the three original Kind templates and their governance. One staging EKS cluster in us-east-1 and one real two-component application are sufficient; template count is not a success metric.

Use the existing React/nginx frontend and Express/Gemini backend in the source repository. Do not copy app source into Backstage. The frontend proxies `/api` to the private backend. There is no AWS API Gateway or application database in this design. Cloud access uses the operator-IP-restricted ALB and temporary self-signed HTTPS already selected; no purchased domain. Keep frontend/backend releases paired from one commit. Hosting Backstage on EKS, production, additional clouds, general multi-tenancy, and Crossplane remain deferred. Adding storage for screenshots via a bounded Crossplane API is a possible future application feature, not a required or existing dependency.

## Developer entry point and data sources

Open the Rizz.AI System from Catalog to reach the Control Center. Component pages link into the same app/environment context. Add entity cards/tabs through the installed new frontend APIs; reuse existing release/proposal/delivery services. Existing standalone routes can redirect or link into this experience without breaking bookmarked proposals. Keep professional styling consistent with the current Agent Guard UI, accessible controls, responsive layout, and real loading/error/stale states.

| Area | Required behavior and evidence source |
| --- | --- |
| Overview | Architecture, authenticated ownership, source/API links, current desired and observed release, timestamped environment health |
| Builds & releases | Actual GitHub workflow results, scans and paired ECR digests, source commit, provenance, retention/eligibility |
| Environments | Original Kind demo target and Rizz.AI EKS staging clearly distinguished; account/region/namespace, endpoint, readiness, expiry/checkpoint where applicable |
| Operate | Working deploy, change-runtime, rollback and request-retirement forms in Rizz.AI context; submit proposal only |
| Reviews | Scoped queue, requester and role, declared intent/provenance, current-to-proposed structured/line diff, policy reasons, Jev Choice/Noul/Score, exact digest, eligible reviewer decision |
| Delivery | Persisted proposal/task/PR references and independently observed merge, Argo revision, both rollouts, smoke outcome, timestamps and failures |
| Kubernetes | Actual Deployments/ReplicaSets/Pods, Services/Ingress, events and available resource metrics; read-only access, no secret values or ungoverned restart/delete controls |
| Service readiness | Deterministic per-check evidence, pass/fail/unknown, source and checked-at timestamp; no fabricated maturity percentage |
| Docs | TechDocs architecture, deploy/update/rollback, Gemini outage, failed rollout, access/secrets and teardown runbooks |
| Infrastructure | Platform-only Terraform requests, plans, approvals, apply/destroy history, drift and foundation status; see `rizz-idp-terraform.md` |

Catalog contains System/rizz-ai, Component/rizz-frontend, Component/rizz-backend, API/rizz-api, and Resources for the EKS cluster, staging namespace and ECR repositories (a grouped registry overview may link the two repo resources). App descriptors stay in the app source repo; platform infrastructure descriptors stay in the platform repo. Model dependsOn/providesApis/consumesApis relationships and authenticated owner groups. Catalog resources may describe planned infrastructure, but the UI must distinguish planned/absent from provisioned. Do not add Pods/ReplicaSets as catalog entities or assume a Resource descriptor proves creation. Kubernetes labels and entity annotations must correctly associate both component workload hierarchies.

## Roles and enforcement

Use mapped GitHub Backstage identities and groups `group:default/rizz-team` and `group:default/platform-team`. These are organizational roles, separate from AWS/service credentials. Verify real membership; do not put arbitrary signed-in users in an admin group. New routine app ownership becomes rizz-team; shared foundation stays platform-team. The current cloud implementation uses platform-team ownership/review: migrate deliberately with versioned contracts, leaving historical snapshots and authorizations intact. A two-person demo can use one application requester and one platform reviewer; app-team peer approval needs a distinct eligible app identity if demonstrated.

| Action | Application role | Platform role |
| --- | --- | --- |
| View authorized Rizz.AI releases, ops, docs and app history | Allow | Allow |
| Submit deploy/runtime/rollback proposal for Rizz.AI | Allow | Allow |
| Approve routine app proposal | Distinct authorized rizz-team reviewer | Distinct authorized platform-team reviewer |
| Submit staging retirement request | Allow | Allow |
| Approve staging retirement | Deny | Distinct authorized platform reviewer |
| View sensitive infrastructure plans/run details | Deny; app readiness summary only | Allow scoped view |
| Submit/review infrastructure configuration and actual plan | Deny | Allow, distinct reviewer for approval |
| Execute Terraform | Deny | Designated operator/runner consumes the approved plan; membership alone is insufficient |
| Maintain templates, policy and target/module configuration | Deny | Reviewed platform repository workflow |
| Read plaintext secrets through portal/MCP | Deny | Deny |

Enforce backend/API/MCP/Scaffolder permissions at every action, not only navigation or buttons. Catalog ownership is context, not the only authorization check. Self-review, guest approval, arbitrary owner overrides and role escalation are denied. Bind policy version/reviewer eligibility to proposals and recheck authenticated membership at execution. Agent credentials inherit the requester submission scope, never approval/apply authority. Platform access to templates/configuration does not bypass app or Terraform review.

Credentials have separate scopes: app CI pushes only the paired ECR images; Backstage publisher writes approved PRs to allowed repositories; Argo reconciles permitted Kubernetes resources; Terraform runner manages the approved foundation; release/cloud observers read evidence; External Secrets retrieves the specific runtime secret. Browser and MCP never receive service credentials.

## Shared operation contract

Implement a discriminated operation contract with `deploy`, `runtime_change`, `rollback`, `retire`; resolve app and target server-side. Names below are design conventions; match installed APIs while preserving semantics. Manual forms and official MCP proposal/status actions call the same service. A safe authorized read action may supply current configuration/releases to the agent. Do not expose approve, execute, merge, sync, kubectl, arbitrary workflow dispatch or shell as agent tools.

Every executable change freezes operation/version, authenticated requester, declared intent/provenance, authorized app/target/owner, policy and recipe versions, current GitOps revision/file hashes, exact before/after content including deletions, relevant retained release evidence, and generated content hashes. Include a structured change summary and readable file diff. Backend derives the summary from actual output. UI confirmation binds the exact digest. Revalidate before task dispatch, PR publication and final merge checks; changed relevant configuration requires refreshed review. Persist audit/external IDs; recover known task/PR results idempotently after timeouts, never duplicate blindly.

Normal flow: structured input validation → current desired-state and independent evidence reads → deterministic preview → Jev semantic evaluation → policy/review gate → distinct review → private task-bound Scaffolder execution → GitOps PR → human merge → Argo reconciliation → independent observation. The agent cannot directly mutate the cluster. Cloud currently starts with manual Argo sync; the desired IDP automates ordinary merged app changes only after reviewed AppProject/repository/sync-policy setup. Display manual-sync waiting truthfully until configured; refresh never deploys.

### Deploy

Select an eligible verified paired release by immutable ID/record digest, target and bounded replica counts. Reject failed, foreign, missing/expired or mutated evidence; no arbitrary image or YAML input. Preview current vs new pair and configuration. Open the exact approved PR; verify both workload images/readiness and end-to-end health. Deploy never provisions EKS or runs Terraform. Initial deploy may use reviewed recipe defaults; subsequent release updates preserve existing runtime settings unless explicitly requested.

### Runtime change

Example: “Increase only the Rizz.AI backend to two replicas in EKS staging. Keep frontend, images and Gemini settings unchanged.” Proposed input contains operation, target, declaredIntent and a typed patch such as `{backendReplicas: 2}`. Backend reads the current desired config, preserves every omitted value, and renders the result. Do not resubmit an entire app from new defaults or require an image build/release selection to change capacity.

Both Deployment replica counts are integer 1–2. Expose platform-owned `small`/`medium` CPU/memory profiles only after defining measured values for each component, quota and rollout headroom, validating schedulability and versioning them; profile names cannot substitute for implementation. Gemini model changes use a supported model allowlist and compatibility tests. Other runtime fields remain fixed until a reviewed schema supports them. Unknown fields, arbitrary env/secrets/images/nginx/API prefixes and changes outside the operation's permitted fields fail deterministically. Replicas=3 is rejected before Jev; never clamp it. Require desired config and enough observed deployment evidence to preview safely; an unreadable/unsupported baseline cannot be reconstructed from defaults. Read-only monitoring refresh failure alone must not manufacture a config change.

A scaling operation must enforce that image digests, frontend settings, exposure, routing, secret references and model are unchanged. A supported combined config change uses an explicit wider patch and matching declared intent. Show requests vs actual available replicas. No-op proposals show no change rather than open a redundant PR. If HPA is later introduced, define field ownership first; do not promise fixed replica counts while an autoscaler controls them.

### Rollback

List previously verified deployment records with image pair, compatible config snapshot, source/approval/merge identifiers and observed success timestamp. A previous CI build alone is not a previously healthy deployment. Select the exact record; freshly verify artifact/image availability and recipe compatibility. Restore its image pair and compatible runtime config through a new approved PR. Preserve target identity, current secret references and ingress/security configuration; incompatible historical changes require a migration, not blind repo revert.

Keep at least the current and preceding verified release eligible for the planned demo, with a published retention policy covering CI artifacts, records and ECR images. New source CI records/artifacts use 30-day retention and the browser still lists only three recent runs; persistent verified-deployment records and exact-release revalidation must remain the rollback source of truth. This is not a durable archival guarantee: repository retention settings or deletion can shorten availability. Missing/deleted/expired evidence makes rollback unavailable with a clear remedy. Distinguish runtime recovery from Terraform rollback. Prove recovery through real rollouts/smoke checks, not an Argo history badge or kubectl undo.

### Retire

Retirement is a dedicated destructive app operation. Requester selects the exact Rizz.AI staging target and supplies a reason; backend previews app resources to delete, records to retain, and foundation resources unaffected. Only a distinct platform reviewer can approve. Destructive snapshots bind deletion sets and preconditions; publisher must support reviewed deletions, not merely adding/replacing manifests.

Use staged approved GitOps cleanup: remove ingress first while the load-balancer controller operates, verify controller-owned ALB/target-group cleanup, then remove app workloads/config/secret-sync declarations and dedicated environment resources. Handle Argo Application/finalizers and parent desired state so deleted resources are not immediately recreated. Platform-managed namespace removal requires explicit ownership and an inventory proving no other workloads depend on it. Do not casually enable allowEmpty/prune and call folder deletion complete. Show partial/blocked cleanup and residual resources. Preserve audit/history; document exact secret/image retention. Retirement never implicitly destroys EKS/VPC/state; foundation destroy is a separate actual-plan approval.

## Environments, secrets and observability

The required initial app target is existing EKS staging. Foundation setup creates its namespace/access/quotas using reviewed platform-owned configuration; release execution does not secretly create namespaces. A later bounded environment request can create an approved namespace/quota/Argo target on the existing cluster, with capacity, secrets, routing, expiry and deletion ownership defined. Multiple previews/new clusters are not prerequisites for the initial lifecycle MVP.

Manage Gemini/runtime secret values out of portal inputs through Secrets Manager and External Secrets. Show references and sanitized sync/refresh/rollout status, not values. Provide a tested rotation runbook; environment-injected secret updates may need a controlled restart and must not use an ungoverned pod-delete button.

Add measured request count, API latency/errors, Gemini timeout/rate-limit/provider-failure counters, and sanitized correlated logs. Show per-process rate-limit/call-count semantics accurately; two replicas can increase total usage. Health/readiness probes must not incur Gemini calls. Smoke verification distinguishes local mock integration, real cloud routing/health, and an explicitly bounded live Gemini test. Do not label health endpoints as proof of successful Gemini generation. Use a monitoring stack sized to the node; functional external dashboard/log links are acceptable when they land on the exact app/environment and actual data.

Readiness checks cover owner/source/API/TechDocs/runbooks, successful CI and scans, immutable digests, probes, requests/limits, available retained rollback, and observed delivery. Each check has deterministic criteria, evidence URL, timestamp and unknown state. A score, if shown, states denominator/weights and unknowns; it is separate from Jev and cannot claim an SLO or production maturity from one demo.

## Jev semantic contract

Send declared intent, operation purpose, compact before/after summary, changed fields, preserved fields and scope. Noul/Choice/Score remain advisory semantic outputs with rubric/probabilities and conflict/unavailable handling. Numerical bounds, exact release digest checks, patch field scope, IAM, owner/target authorization and unsupported fields belong in code.

Meaningful semantic negative cases use individually valid changes: intent asks backend-only scale but patch also scales frontend; intent says keep the Gemini model but an allowed model change is proposed; intent asks the last healthy deployment but a different eligible deployment is selected. The reviewer sees the discrepancy; ordinary approval remains held under the established semantic policy. A guessed natural-language explanation is not model output. Generic “deploy something” must not be presented as strong evidence of preserved intent.

An agent asking for `apiGatewayPathPrefix` meets an unsupported-schema error because no API Gateway or route-change operation exists. If route changes become supported later, they need a separate compatibility contract covering browser/nginx/Express routes. A favorable Jev result never enlarges the allowed schema or authorizes unrelated changes.
