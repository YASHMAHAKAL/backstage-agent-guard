---
name: backstage-agent-guard
description: Plan, build, review, debug, test, or document Backstage Agent Guard and the Rizz.AI lifecycle IDP, including its Kind demo, Backstage MCP, Jev, EKS GitOps, role permissions, and governed Terraform controls. Use for this project and its Rizz.AI platform extension.
---

# Backstage Agent Guard

Use this skill for this project. It records the agreed product behavior and decisions that are easy to reverse accidentally. It is a project guide, not evidence that code already exists. Inspect the workspace before claiming a feature is implemented. Explicit user changes take precedence.

## Outcome

A developer asks Codex to create and deploy a service. Platform owners have already registered three trusted Backstage Scaffolder templates. Codex submits a structured proposal through the **official Backstage MCP Actions backend**. Agent Guard validates it, uses Jev to compare the proposal with declared intent, applies deterministic review policy, and shows the frozen change on a Backstage approval page. After approval, a trusted backend runs Scaffolder, which opens a GitOps pull request. A human merges it; Argo CD syncs the tracked branch to Kind. Backstage links the proposal, catalog entity, Scaffolder task, pull request, and deployment status.

The three initial templates are an internal Node.js API, an internal Python FastAPI service, and a scheduled worker using Kubernetes CronJob. Their prebuilt demo images and two-repository Kind workflow remain supported.

The user has expanded the project into a Rizz.AI application lifecycle IDP. Required outcomes are an application-centered Backstage Control Center, verified releases, deploy/runtime-change/rollback/retirement workflows, application and platform roles, real operational visibility, service-readiness checks, and platform-only Terraform request/plan/approve/apply/destroy controls. A single deployment template does not complete this scope. Use the existing application source repository, the Backstage/platform repository, and the GitOps repository. Keep application builds, Terraform infrastructure provisioning, and Argo CD application deployment as separate workflows. The detailed plan is a design target, not evidence that it has been implemented.

## Select the operating mode

- **Local demo:** Existing three templates, Kind, local Backstage, and local staging. Read the original references below. Their two-repository and internal-only restrictions apply to these templates.
- **Rizz.AI cloud:** Existing application source, paired frontend/backend releases, a dedicated EKS staging target, and separate cloud GitOps paths. Read `cloud-architecture.md` and the relevant cloud references below. Cloud-specific instructions override only the original local scope assumptions; shared identity, approval, MCP, and Jev safeguards still apply.
- **Rizz.AI IDP lifecycle:** Read `rizz-idp-lifecycle.md` for product/roles/operations, `rizz-idp-delivery.md` for required completion evidence, and `rizz-idp-terraform.md` for infrastructure controls. These supersede earlier cloud references where lifecycle or Terraform controls were optional. They do not imply the capabilities are implemented.
- **Shared changes:** Preserve both modes. Inspect the existing implementation and add explicit target configuration rather than repointing a local cluster, Argo Application, template, or frozen proposal at AWS.

If the target is unclear, inspect the active configuration and ask before any external mutation. Never silently interpret `staging` as the other cluster.

## Boundaries to preserve

- The agent may submit and inspect proposals. It may not call `scaffolder.execute-template`, publish GitOps changes, approve itself, or mutate Kubernetes/Argo CD directly through Agent Guard tools.
- Every approval requires an authenticated authorized reviewer who is a **different Backstage user from the requester**. Kind retains distinct owner-group review. Rizz.AI routine changes allow authorized application or platform reviewers; retirement and infrastructure changes require platform review as specified in `rizz-idp-lifecycle.md`. Shared guest identities cannot approve or have their proposals approved. Role migration must not retroactively widen historical approvals.
- Register Agent Guard proposal/status actions with Backstage Actions Registry and expose them through official MCP Actions. Restrict `backend.actions.pluginSources` to intended sources. Named MCP filters alone are insufficient: the default MCP endpoint exposes every registered action.
- MCP filtering is only one boundary. Block direct Scaffolder task creation for protected templates through backend permissions, and make the GitOps publishing action verify a live approved snapshot. Test `/create`, Scaffolder REST, dry-run, and MCP bypass attempts; none may publish without approval.
- Treat `declaredIntent` as **agent supplied** until an authenticated human confirms it. Do not claim it proves the user's original words.
- Derive intent provenance and requester identity in the backend. Agent-provided `intentSource`, requester, or reviewer fields are not authority. A static MCP token identifies a service, not a developer; use per-user OAuth for requester attribution or require authenticated Backstage confirmation before review.
- Structured facts and authenticated identity feed explicit policy. Jev judges semantic alignment, unrequested scope, and ambiguity; it never grants execution permission.
- Freeze the executable proposal before review. Bind approval to declared intent/provenance, template identity/version, validated inputs, GitOps target, and rendered output or an equivalent deterministic snapshot. Revalidate before execution. Any material edit invalidates approval.
- Distinguish Backstage approval from GitOps PR merge. Approval authorizes Scaffolder to open the PR; merging allows Argo CD to deploy. An open PR is not a deployment.
- Keep the local portfolio demonstration available. The cloud extension initially adds one EKS staging environment and one real application; production, multi-region operation, and high availability are not implied.
- Cloud infrastructure must exist before a release request can deploy an application. Backstage approval permits an approved GitOps PR; AWS rollout begins only after its human merge and Argo CD reconciliation. Application releases must not run Terraform.
- Keep Terraform and GitOps resource ownership disjoint. Terraform owns the AWS foundation; Argo CD owns application manifests. Crossplane is deferred until a real application resource requirement is explicitly approved.
- Implement real backend operations, execution adapters, persistence, and failure states behind every actionable lifecycle/infra control. Mock providers belong in tests or explicitly labeled exploration only; mock output cannot satisfy delivery or portfolio completion.
- Permission to edit this skill or plan the platform does not authorize AWS provisioning, billable API tests, external PRs, repository edits outside scope, deployment, or destruction. Confirm that the current request authorizes the specific operation; ask when that authority is missing.

## Load references by task

- For user stories, template inputs, proposal states, approval UI, and sequence, read [references/product-workflow.md](references/product-workflow.md).
- For trust boundaries, MCP exposure, policy, Jev design, approval integrity, and GitOps, read [references/architecture.md](references/architecture.md).
- For implementation order, stack, tests, demo, and blog evidence, read [references/delivery.md](references/delivery.md).
- When an external API or package behavior matters, consult [references/sources.md](references/sources.md), then verify current official docs and installed types.
- For Rizz.AI source integration, repo boundaries, AWS foundation, portal configuration, identities, secrets, and local/cloud separation, read [references/cloud-architecture.md](references/cloud-architecture.md).
- For cloud template inputs, verified releases, Jev examples, approvals, infrastructure requests, deployment observation, and rollback, read [references/cloud-workflows.md](references/cloud-workflows.md). Also read `architecture.md` for any shared governance change.
- For cloud implementation phases, authorization checkpoints, acceptance tests, cost controls, and official sources, read [references/cloud-delivery.md](references/cloud-delivery.md). The original `delivery.md` is the historical local roadmap; inspect code before attempting to repeat completed milestones.
- For the accepted Rizz.AI Control Center, roles, operation contracts, Jev use, and DevEx outcomes, read [references/rizz-idp-lifecycle.md](references/rizz-idp-lifecycle.md).
- For platform-only Terraform controls, runner authority, saved-plan review, state, CI, drift, and teardown, read [references/rizz-idp-terraform.md](references/rizz-idp-terraform.md).
- For the current implementation sequence, acceptance matrix, live demo, and resume/blog evidence, read [references/rizz-idp-delivery.md](references/rizz-idp-delivery.md). This extends the cloud foundation roadmap; do not repeat completed foundation work.

## Working method

1. Determine whether the task is planning, implementation, review, debugging, or documentation. Read only relevant references and inspect existing code before editing.
2. Application operations follow MCP or manual proposal → validation → Jev → deterministic policy → hash-bound human review → private Scaffolder → GitOps PR → merge → Argo reconciliation → verification. Infrastructure operations follow the distinct exact-plan review and runner workflow in `rizz-idp-terraform.md`.
3. Keep model outputs and policy decisions separate in data, APIs, UI, tests, and blog. Show Noul, Choice, and Score without presenting their probabilities as authorization guarantees.
4. For implementation, verify the success path and the relevant bypass or mismatch path. For planning only, do not create cloud resources, external repos, PRs, or deployments unless requested.
5. Report what works, what is simulated, and what remains. Do not describe planned features as complete.

## Agreed platform choices

| Concern | Choice |
| --- | --- |
| Agent | Codex CLI/IDE with the user's ChatGPT Plus access |
| Agent tool surface | Official Backstage MCP Actions with custom Agent Guard actions |
| Developer portal | Rizz.AI entity Control Center, lifecycle operations, releases, reviews, Kubernetes, readiness checks, TechDocs |
| Semantic check | Jev with a separate TypeSafe API credential |
| Review | Application/platform roles, deterministic policy, distinct authenticated human decision |
| Delivery | Scaffolder creates GitOps PR; human merges; Argo CD syncs |
| Local environment | Kind, staging namespace, Argo CD |
| Cloud environment | AWS EKS staging; dedicated in-cluster Argo CD |
| Infrastructure | Terraform foundation and Backstage platform-only request/plan/approve/apply/destroy workflow |
| Real application | Existing Rizz.AI React/nginx frontend and Express/Gemini backend |
| Images | ECR; verified release with pinned frontend/backend digests |
| Repositories | Backstage/platform + GitOps; Rizz.AI source added for cloud mode |
| Portal hosting | Local initially; EKS hosting with durable PostgreSQL is a later milestone |
| Crossplane | Deferred; no overlapping ownership with Terraform |

These are design targets. Adapt exact extension APIs and package versions to the installed release when implementation starts.
