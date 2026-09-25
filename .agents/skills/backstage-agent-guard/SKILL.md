---
name: backstage-agent-guard
description: Plan, build, review, debug, test, or document the Backstage Agent Guard portfolio project using official Backstage MCP Actions, Jev intent checks, Scaffolder approvals, and Argo CD GitOps deployment. Use only for this project, not unrelated Backstage or Jev work.
---

# Backstage Agent Guard

Use this skill for this project. It records the agreed product behavior and decisions that are easy to reverse accidentally. It is a project guide, not evidence that code already exists. Inspect the workspace before claiming a feature is implemented. Explicit user changes take precedence.

## Outcome

A developer asks Codex to create and deploy a service. Platform owners have already registered three trusted Backstage Scaffolder templates. Codex submits a structured proposal through the **official Backstage MCP Actions backend**. Agent Guard validates it, uses Jev to compare the proposal with declared intent, applies deterministic review policy, and shows the frozen change on a Backstage approval page. After approval, a trusted backend runs Scaffolder, which opens a GitOps pull request. A human merges it; Argo CD syncs the tracked branch to Kind. Backstage links the proposal, catalog entity, Scaffolder task, pull request, and deployment status.

The three initial templates are an internal Node.js API, an internal Python FastAPI service, and a scheduled worker using Kubernetes CronJob. Use prebuilt demo images to preserve a two-repository MVP. A new application source repository is outside this scope unless the user expands the project.

## Boundaries to preserve

- The agent may submit and inspect proposals. It may not call `scaffolder.execute-template`, publish GitOps changes, approve itself, or mutate Kubernetes/Argo CD directly through Agent Guard tools.
- For this MVP, every approval requires an authenticated member of the requested owner group who is a **different Backstage user from the requester**. Same-team requester confirmation is no longer an approval lane. Shared guest identities cannot approve or have their proposals approved; use mapped real users for the two-person path.
- Register Agent Guard proposal/status actions with Backstage Actions Registry and expose them through official MCP Actions. Restrict `backend.actions.pluginSources` to intended sources. Named MCP filters alone are insufficient: the default MCP endpoint exposes every registered action.
- MCP filtering is only one boundary. Block direct Scaffolder task creation for protected templates through backend permissions, and make the GitOps publishing action verify a live approved snapshot. Test `/create`, Scaffolder REST, dry-run, and MCP bypass attempts; none may publish without approval.
- Treat `declaredIntent` as **agent supplied** until an authenticated human confirms it. Do not claim it proves the user's original words.
- Derive intent provenance and requester identity in the backend. Agent-provided `intentSource`, requester, or reviewer fields are not authority. A static MCP token identifies a service, not a developer; use per-user OAuth for requester attribution or require authenticated Backstage confirmation before review.
- Structured facts and authenticated identity feed explicit policy. Jev judges semantic alignment, unrequested scope, and ambiguity; it never grants execution permission.
- Freeze the executable proposal before review. Bind approval to declared intent/provenance, template identity/version, validated inputs, GitOps target, and rendered output or an equivalent deterministic snapshot. Revalidate before execution. Any material edit invalidates approval.
- Distinguish Backstage approval from GitOps PR merge. Approval authorizes Scaffolder to open the PR; merging allows Argo CD to deploy. An open PR is not a deployment.
- Keep this a portfolio demonstration: one Kind cluster, one staging environment, three small templates, and a meaningful end-to-end test are enough.

## Load references by task

- For user stories, template inputs, proposal states, approval UI, and sequence, read [references/product-workflow.md](references/product-workflow.md).
- For trust boundaries, MCP exposure, policy, Jev design, approval integrity, and GitOps, read [references/architecture.md](references/architecture.md).
- For implementation order, stack, tests, demo, and blog evidence, read [references/delivery.md](references/delivery.md).
- When an external API or package behavior matters, consult [references/sources.md](references/sources.md), then verify current official docs and installed types.

## Working method

1. Determine whether the task is planning, implementation, review, debugging, or documentation. Read only relevant references and inspect existing code before editing.
2. Preserve the path: MCP proposal → validation → Jev check → deterministic policy → Backstage review → hash-bound approval → internal Scaffolder task → GitOps PR → merge → Argo CD sync.
3. Keep model outputs and policy decisions separate in data, APIs, UI, tests, and blog. Show Noul, Choice, and Score without presenting their probabilities as authorization guarantees.
4. For implementation, verify the success path and the relevant bypass or mismatch path. For planning only, do not create cloud resources, external repos, PRs, or deployments unless requested.
5. Report what works, what is simulated, and what remains. Do not describe planned features as complete.

## Agreed platform choices

| Concern | Choice |
| --- | --- |
| Agent | Codex CLI/IDE with the user's ChatGPT Plus access |
| Agent tool surface | Official Backstage MCP Actions with custom Agent Guard actions |
| Developer portal | Backstage Catalog, Agent Guard UI, Scaffolder, Argo CD status |
| Semantic check | Jev with a separate TypeSafe API credential |
| Review | Deterministic policy and authenticated human decision |
| Delivery | Scaffolder creates GitOps PR; human merges; Argo CD syncs |
| Local environment | Kind, staging namespace, Argo CD |
| Repositories | Backstage app repo and separate GitOps repo |

These are design targets. Adapt exact extension APIs and package versions to the installed release when implementation starts.
