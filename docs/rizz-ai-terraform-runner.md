# Rizz.AI Terraform runner handoff (not activated)

The Terraform runner is a separate Node process. Backstage records the
request, checks a reviewed configuration PR, displays the sanitized saved
plan, and issues a distinct-reviewer receipt. The runner owns the private
plan file and any AWS credentials. The browser, MCP and Scaffolder cannot
launch Terraform. A runner-reported `applied` result is **not** independent
proof that EKS is ready.

## Current safe state

The runner script is [scripts/terraform-runner.cjs](../scripts/terraform-runner.cjs).
It has not been run against AWS, connected to a protected CI environment, or
given apply credentials. `plan` would contact GitHub, the configured AWS
account, S3 and Terraform's backend; `apply` would modify AWS. Neither
command is part of normal Backstage startup, and this document is not
authorization to run them. No `.env` token or private plan belongs in Git.

The runner requires a clean checkout at the reviewed merge commit, an owned
mode-0700 artifact directory **outside** that checkout, fixed
`state.backend.hcl` and private `terraform.tfvars` in the selected root, and
Terraform 1.15.x. A plan is short-lived (30 minutes). After expiry or any
input/state change, generate and review a new plan; never reuse an old
approval. A plan's raw JSON and binary stay with the runner, not Backstage.

The Backstage service token is configured only with the opt-in
[configuration example](../app-config.rizz-terraform.yaml.example). Restrict
it to the `agent-guard` plugin and store it separately from the runner HMAC
and approval keys. The platform backend's existing six Terraform settings
must also be configured; see [control status](rizz-ai-terraform-control-status.md).
This is a _local operator_ adapter; moving it into GitHub Actions requires a
reachable Backstage service, protected workflow/branch, verified OIDC subject,
least-privilege role and private durable plan artifact. Do not use a
pull-request workflow with AWS authority.

## Non-deploying sequence

1. An authenticated platform member records a `foundation_setup` request.
2. A platform-owned Terraform configuration PR is reviewed by a different
   person and merged to `main`. The PR must change the selected root. This
   step is still **manual**: the current fixed setup request contains no
   meaningful Terraform delta for an automatic publisher.
3. Once an operator has provisioned and verified the state bucket and backend
   credentials, the designated runner can fetch the pending request, verify
   the PR/current merge, check the account and exact S3 state key, then create
   a saved plan. An empty initial state is accepted only if S3 independently
   confirms that the expected object is absent. An inaccessible bucket or
   existing unreadable state fails closed. This check creates no AWS resource.
4. The runner registers only the plan digest, binding and redacted changes.
   Backstage allows a different current platform member to approve that
   exact plan. Merely merging the PR does **not** authorize apply.

An explicit operator-invoked `apply` mode exists in code but remains inactive
until the live AWS authorization checkpoint. It requires both a command-line
activation flag and `AGENT_GUARD_ENABLE_TERRAFORM_APPLY` set to the exact
activation phrase. It fetches the current receipt again, checks the plan bytes,
source, account, variables, backend, state, reviewer membership and expiry,
and consumes a durable single-use local claim before running `terraform
apply <saved-plan>`. Failed or interrupted execution is `unknown`, not an
automatic retry. The backend stores the runner's report, while independent
AWS inventory/readiness observation remains future work.

## First-state and teardown boundary

The S3 state bucket must be created by a separate authorized bootstrap
operator first; no runner can bootstrap its own missing backend. Preserve its
versioning/encryption/lock policy and capture the bootstrap plan and outputs.
For teardown, retire the application and verify controller-owned ALB removal
before any separately approved staging destroy. This runner script currently
accepts only `foundation_setup` plans; it does not offer a destroy command.

The user-agreed US$5/four-hour checkpoint is an operating constraint, not a
hard cap. Re-estimate before any live plan/apply and arrange teardown before
resource creation.

Implementation references: [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3),
[Terraform automation](https://developer.hashicorp.com/terraform/tutorials/automation/automate-terraform),
[S3 ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
[Backstage external service tokens](https://backstage.io/docs/auth/service-to-service-auth/).
