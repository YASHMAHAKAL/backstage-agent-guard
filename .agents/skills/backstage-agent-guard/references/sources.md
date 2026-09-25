# Source map and currency checks

These sources supported the design on 2026-09-23. Reopen current docs when implementing a version-sensitive API; prefer official primary documentation and installed package types.

## Backstage

- [MCP Actions backend](https://backstage.io/docs/ai/mcp-actions/): installation, `backend.actions.pluginSources`, default endpoint behavior, named filters, authentication, tracing.
- [Scaffolder authorization](https://backstage.io/docs/features/software-templates/authorizing-scaffolder-template-details/): task creation, inline dry-run, and action execution permissions; MCP filtering does not protect these paths.
- [Scaffolder audit events](https://backstage.io/docs/features/software-templates/audit-events/): direct `POST /v2/tasks` task creation and dry-run endpoints.
- [Backstage threat model](https://backstage.io/docs/overview/threat-model/): default internal-user template execution and recommended restrictions on Template, User, and Group ingestion.
- [GitHub pull-request publishing action API](https://backstage.io/api/stable/functions/_backstage_plugin-scaffolder-backend-module-github.createPublishGithubPullRequestAction.html): supported Scaffolder GitOps PR primitive; pin installed API version and gate it behind approved-snapshot checks.
- [Actions Registry](https://backstage.io/docs/backend-system/core-services/actions-registry/): action schemas, credentials, attributes, and `visibilityPermission`.
- [Well-known actions](https://backstage.io/docs/ai/well-known-actions/): Scaffolder execute and dry-run actions that should not be agent-callable in this design.
- [Software Templates](https://backstage.io/docs/features/software-templates/) and [Writing Templates](https://backstage.io/docs/features/software-templates/writing-templates/): Template entities, parameters, steps, publishing, and catalog registration.
- [Template dry runs](https://backstage.io/docs/features/software-templates/dry-run-testing/): dry-run support is action-specific and does not simulate every external effect.
- [Catalog entity descriptor](https://backstage.io/docs/features/software-catalog/descriptor-format/): owner relations and caution against using ownership alone as runtime authorization.
- [Backstage permissions](https://backstage.io/docs/permissions/overview/): authenticated authorization.
- [Community Argo CD plugin](https://github.com/backstage/community-plugins/blob/main/workspaces/argocd/plugins/argocd/README.md): annotations and status display; check compatibility at implementation.

## TypeSafe Jev

- [API reference](https://docs.typesafe.ai/api): Noul, Choice, Score shapes, probabilities, confidence, and rubric semantics.
- [Patterns](https://docs.typesafe.ai/patterns): bounded decisions, confidence-gated routing, intent routing.
- [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): literal reading, numbers, adversarial content, structural inconsistency, irrelevant context.
- [Confidence](https://docs.typesafe.ai/confidence): confidence is not an authorization decision.

## GitOps and approval integrity

- [Argo CD automatic sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/): reconciles tracked Git desired state to Kubernetes.
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html): stable JSON representation for hashing.
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html): independently validated execution and exact-action approval.

## Codex skill and access

- [OpenAI Docs: build skills](https://learn.chatgpt.com/docs/build-skills): `SKILL.md`, repository-local `.agents/skills`, explicit `$skill-name` invocation.
- [OpenAI Docs: pricing](https://learn.chatgpt.com/docs/pricing): ChatGPT Plus includes Codex CLI/IDE access subject to limits; it does not supply TypeSafe credentials.
- [OpenAI Docs: MCP](https://developers.openai.com/learn/docs-mcp): Codex CLI/IDE MCP configuration.
