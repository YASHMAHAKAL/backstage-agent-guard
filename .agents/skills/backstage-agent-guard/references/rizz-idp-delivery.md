# Rizz.AI IDP implementation and completion evidence

## Start from observed capability

This is the required lifecycle completion roadmap. Read `rizz-idp-lifecycle.md` and, for infrastructure, `rizz-idp-terraform.md`. Existing cloud foundation phases remain dependencies. Inspect code/config/tests/live state rather than starting over. At the plan update, local code includes catalog descriptors, release browser, governed cloud deploy/review/observation adapters, source CI files and Terraform/bootstrap code. Runtime-change, dedicated rollback/history, retirement, the combined Control Center/two-role migration and Terraform portal/runner are still planned. Nothing in this reference claims live EKS deployment.

Preserve the dirty worktree and original Kind demonstration. Use existing providers and security controls; introduce versioned operation envelopes rather than rewriting historical snapshots. This skill update is not an instruction to provision AWS. Continue authorized implementation through meaningful verified increments; do not repeatedly request choices already settled or stop after a UI stub when the backend can be built locally.

## Milestones and exit evidence

| Milestone | Required deliverables | Evidence before marking complete |
| --- | --- | --- |
| 1. App model and roles | Rizz.AI System/component/API/infrastructure relationships; real user/group mappings; scoped API/UI/MCP permissions and versioned policy | Real catalog ingestion/links; authorization tests for app/platform/outsider/guest/self-review and historical snapshot compatibility |
| 2. Lifecycle backend | Deploy/runtime-change/rollback/retire schemas, shared preview/approval/executor, persisted operation records, exact diffs/deletions and release history | Scaling preserves omitted fields; rollback selects real verified history; publisher correctly creates and deletes approved files; concurrent base/approval changes fail safely |
| 3. Control Center | Working entity tabs/cards, operation forms/reviews, release/history views, delivery/Kubernetes/runbooks links and role-specific infrastructure entry | Browser/manual workflow with real auth and source data; loading/unavailable/stale/empty states and meaningful navigation; no operative fake buttons |
| 4. Infra controls | Platform PR/plan/approval/runner/status/drift/destroy integration with scoped credentials and saved-plan artifact contract | Local tests of real adapters plus isolated workflow validation; rejection of stale/swapped/replayed plans, unauthorized dispatch and wrong target; live execution remains a separate evidence checkpoint |
| 5. Operations/readiness | Actual metrics/log data, app-specific dashboards and TechDocs, deterministic readiness checks, retention/recovery/cleanup runbooks | Provider failure visible as failure; no paid probes; unknown/missing data shown honestly; a developer can find and use docs and actual workload evidence |
| 6. Short cloud acceptance | Reviewed live foundation, ECR release(s), EKS/controller/Argo/secrets setup, deploy/update/rollback/retire then approved foundation teardown | Real GitHub/registry/Argo/Kubernetes/HTTPS evidence, bounded Gemini functional check if authorized, residual AWS inventory and retained-state record within cost/checkpoint plan |
| 7. Portfolio handoff | Architecture/repo/ownership diagrams, reproducible local demo, tested runbooks, measured DevEx, blog/demo and accurate resume claims | A second person can complete the documented tasks; published claims map to observed evidence and limitations |

Work through 1–5 locally before starting the short billable cloud run. Use a labeled local Rizz.AI container environment for lifecycle integration where feasible; keep its target separate from Kind's three starter services and cloud snapshots. Local/synthetic AWS evidence cannot be an executable cloud release. Build real code paths with injected providers for tests, then activate cloud adapters only with actual dependencies. Resolve external access blockers after preparing concrete artifacts; do not replace blocked integrations with green mock statuses.

## Feature completion rule

An actionable feature is locally implemented only when schema, authenticated service, persistence/state transitions, deterministic preview/diff, policy/Jev behavior, appropriate executor/observer adapters, UI, runbook and relevant success/failure tests exist. Mark activation and live demonstration separately. Writing a template file, interface type, link, sample JSON, hardcoded status or mocked test alone is not completion.

Read-only plugin/dashboard links are acceptable if installed/configured, authorized, correctly scoped and tested against actual app evidence. Decorative scorecards and empty monitoring pages are not. Service readiness never uses Jev output as a maturity score. Metrics unknown is not zero. Images built in CI but not run on EKS are not deployed.

Templates should represent useful recipes; lifecycle operations may share one private executor. Do not duplicate arbitrary skeletons to increase template count. Required operator controls must remain protected on REST, MCP and Scaffolder paths. End-to-end retirement needs actual delete semantics and observed ALB cleanup; a delete button with no executor is a stub.

## Required behavioral acceptance cases

| Scenario | Expected outcome |
| --- | --- |
| Agent/manual deploy | Same backend rules, authenticated requester/provenance, exact paired release, distinct review, at most one PR, observed rollout |
| “Only backend to 2” | Current backend 1→2; frontend/images/model/routes/secrets unchanged; no image build or Terraform |
| Replicas 3/float/string or unknown API prefix | Deterministic rejection before Jev/execution; no silent normalization to permitted capacity |
| Valid backend+frontend scale patch with backend-only intent | Semantic discrepancy visible and held; schema validity does not prove intent alignment |
| Valid model change with “keep model unchanged” | Jev contradiction/clarification path; no permission inferred from Score/Noul |
| API Gateway path request | Clear unsupported capability because architecture has no API Gateway; no arbitrary config fallback |
| Self-review/outsider/app user calls infra API | Server deny, including direct REST/MCP requests independent of visible UI |
| Unauthorized Scaffolder task/dry-run or replayed claim | Cannot publish or delete protected files |
| Current files/release/target/template edited after review | Approval invalidated; new preview/review |
| Retried publication after timeout | Locate known task/PR by operation identity; no duplicate branch/PR/task |
| Rollback to retained healthy release | Restore compatible pair/config via new PR; images and source evidence reverified; both workloads/smoke recover |
| Rollback record/artifact/image missing or incompatible | Unavailable with actionable reason; never trust expired history or substitute latest |
| GitHub/Argo/Kubernetes/metrics unavailable | Timestamped unavailable/stale view; refresh never invents success or triggers sync |
| Frontend healthy/backend unhealthy | Whole application not verified delivered; dependency/provider failures visible |
| Retirement by application requester | Platform reviewer required; exact deletion preview; app resources/ALB actually removed; foundation retained |
| Terraform configuration approval only | Cannot apply until the actual saved plan is approved |
| Plan/state/config/target changes, swapped artifact, expired approval | Replan/review required; no apply under previous consent |
| Competing infra execution or ambiguous launch | State/run serialization; resolve known run, never force-unlock or blindly relaunch |
| Destroy request | App/controller cleanup first; exact scoped destroy approval; protected retained roots and measured residuals |
| Kind startup without AWS configuration | Original templates/auth/proposal/approval/GitOps observation remain usable |

Do not assert one expected Jev classification as guaranteed for every live run. Offline tests can inject typed model outcomes to validate gates; live semantic demos record actual Choice/Noul/Score, probability distributions and model/prompt version, including disagreements. Deterministic policy tests are separate evidence. Do not hardcode favorable results to make the demo pass.

## Live demonstration and DevEx evidence

Prepare source CI, workflow gates, credentials/target mappings, release retention, state/bootstrap prerequisites, runtime resource measurements and teardown plan before creation. Use one us-east-1 staging cluster, restricted ALB and the agreed US$5 maximum/four-hour checkpoint. Reestimate the run when adding capacity/monitoring; the budget does not guarantee cost or approve apply. Cloud controls can be demonstrated with one selected valid capacity change; no need to spin up more clusters or install unused tooling.

Record a coherent sequence: deploy release A → request backend replicas 1→2 → show semantic scope mismatch and numerical rejection → deploy release B → rollback to retained verified A → request app retirement → verify ALB/app removal → approve foundation destroy → record residual/retained resources. Use distinct identities for request/review. A safe failure demonstration must be bounded, avoid exposing the API/key, and have a working recovery path. Existing CI artifacts/builds and Terraform plans are evidence, not substitutes for the actual sequence.

Collect actual task times and manual steps for release submission, backend scaling, and rollback. Separate operator/bootstrap/reviewer waiting from developer interaction time. Record whether another person completed tasks using only the portal/runbooks and normal PR review. Do not invent time savings without a measured baseline. Preserve timestamps/commits/proposal IDs/PRs/run IDs and sanitized screenshots/video so claims can be verified after EKS teardown.

The blog explains developer pain, ownership boundaries, trust/intent limits, operation contracts, CI vs Terraform vs GitOps, role enforcement, real failure/recovery, cost and cleanup. Resume wording names only demonstrated capabilities; do not claim production readiness, HA, full enterprise multi-tenancy, guaranteed Jev security or cloud hosting of Backstage. Crossplane may be discussed as a deferred resource API, not listed as implemented technology.

## Relevant official references

- Entity-centered catalog graph: https://backstage.io/docs/features/software-catalog/creating-the-catalog-graph/
- New frontend customization: https://backstage.io/docs/features/software-catalog/catalog-customization/
- Catalog types/relationships: https://backstage.io/docs/features/software-catalog/system-model/
- Kubernetes labels/annotations: https://backstage.io/docs/features/kubernetes/configuration/
- TechDocs: https://backstage.io/docs/features/techdocs/creating-and-publishing/
- Quotas and rollout capacity: https://kubernetes.io/docs/concepts/policy/resource-quotas/
- Limit ranges: https://kubernetes.io/docs/concepts/policy/limit-range/
- Argo sync/prune: https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/
- Argo deletion semantics: https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Application-Deletion/

Check versions and actual installed APIs when implementing; do not rely on documentation URLs as proof a plugin or live integration is already configured.
