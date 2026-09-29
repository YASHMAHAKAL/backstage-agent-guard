# Rizz.AI infrastructure control status

The EKS foundation remains local Terraform configuration. No AWS plan, apply,
destroy, OIDC role, deployed runner or state-backed drift check has been
activated by the current IDP work. The portal now has a platform-only
foundation-request and saved-plan review ledger, but no plan has been
registered from AWS and no approval can launch Terraform.

The staging node group now has a bounded `worker_desired_size` (one or two).
The committed `infra/aws/environments/staging/capacity.auto.tfvars.json` pins
one worker and gives a reviewed platform PR one exact capacity field to
change. The hybrid configuration path is implemented locally: foundation
setup uses a platform-authored PR; a bounded Backstage form opens a one-file
capacity PR for 1↔2 workers. The capacity publisher is disabled until a
separate GitHub write token, explicit activation, and a reviewed HTTPS
measurement-evidence URL are supplied. No such live measurements or activation
are claimed here. The backend freezes the main baseline and verifies the
generated PR head, merged file value, and saved-plan worker change. Changing the
tracked file is a Terraform configuration change, not an application replica
change and not a deployment.

The platform repository is now public, and a GitHub-hosted Terraform checks
workflow validates the three roots without AWS credentials or OIDC. Its
[first remote run](https://github.com/YASHMAHAKAL/backstage-agent-guard/actions/runs/36565654642)
passed all four jobs on the public repository. The
staging mock test now asserts the agreed one-to-two worker bound. The
`terraform-apply` environment is restricted to `main`, but GitHub did not
retain the requested reviewer, so it is not an active human gate. No
GitHub-hosted plan/apply job exists. Public visibility alone cannot bridge a
GitHub runner to the locally running Backstage approval service.

`terraformPlan.ts` defines a private saved-plan binding for request, root,
account, region, source commit, provider lock/config/variable/backend digests,
state lineage and serial, plan artifact digest, runner identity and expiry. Its
sanitizer emits action counts, resource address/type/action and the EKS worker
count change only. It never forwards raw Terraform state or before/after
attributes, which may contain secrets. Local execution invariants now reject
capacity plans that change anything except the staging node-group desired
size, reject destructive changes in a foundation setup plan, and reject
non-delete or non-staging changes in a foundation destroy plan. A receipt
helper signs a distinct-reviewer approval and verifies its signature, plan
bytes, exact binding, expiry, current reviewer eligibility and runner ID.
`terraformRunner.ts` adds an unconnected executor library for a separately
credentialed runner. It checks a clean checkout, the actual AWS account,
Terraform version, configuration/variable/backend/lock digests, remote state
identity (including the Terraform provider's named AWS profile), saved-plan
JSON and private plan bytes before consuming a durable single-use claim. A
failed or timed-out apply is recorded as unknown, never
silently retried. This library is **not** a deployed runner or a portal action;
it has not been exercised against AWS. First-state creation still needs an
authorized operator to create the remote S3 backend. The runner now accepts
an empty initial state only after a read-only exact-key S3 listing proves the
object absent in the expected account; inaccessible or present state fails
closed. `terraformPlanPreparation.ts` now provides a designated-runner
preparation path: it checks the reviewed merged commit and actual account,
hashes the exact local inputs, initializes the fixed root, requires readable
remote state, creates a private saved plan, sanitizes it, rechecks input
stability, and registers only the redacted binding and summary. It has unit
tests with stubbed CLI responses, but is **not deployed or invoked by the
portal**. Service-only, HMAC-protected endpoints expose pending request
metadata and the current approved receipt, accept redacted plan registration,
and store a runner-reported outcome. The opt-in separate
`scripts/terraform-runner.cjs` connects these pieces but has not been run
against AWS or deployed to CI. No live AWS or Terraform command has been run.
An opt-in, read-only AWS inventory endpoint is now wired behind authenticated
platform-team membership. With a dedicated
`AGENT_GUARD_TERRAFORM_OBSERVER_PROFILE` in the Backstage backend environment,
the portal can refresh fixed resource checks after verifying the expected AWS
account: EKS cluster and managed node group for staging, or both ECR
repositories and the image-publisher role for registry. Without that profile
it says `not_configured`; wrong-account, access and CLI failures say
`unavailable`, not absent. It does not inspect Terraform state, VPC/NAT/ALB,
controller readiness, drift, or app deployment, and cannot turn a runner's
success report into foundation readiness. This is only partial independent
inventory, tested with stubbed AWS responses; no live AWS observation is
claimed. Full independent result observation remains outstanding before any
Apply/Destroy portal control can be enabled.

The Backstage plugin now persists authenticated platform-team foundation and
capacity requests and accepts a sanitized plan summary only from a Backstage service
principal with a separate runner HMAC proof. A read-only GitHub verifier
requires a same-repository, reviewed, merged configuration PR at the bound
commit, which must still be the platform repository's current `main`; files
must remain inside the selected Terraform root. The AWS account and runner ID
must match platform-owned configuration, not runner-supplied values. A **different**
current platform member can record a digest-bound plan approval. The receipt
is hidden from browser responses and retrievable only by the runner service.
The `/rizz-infrastructure` page shows request status, PR, plan identity and
redacted resource actions, with no Apply/Destroy control. A foundation request
does not create a PR; an operator must prepare a meaningful configuration PR
and provision the separate runner. An activated bounded capacity request can
create the one-file PR but never apply it. Auto-creating a PR that only records
a foundation request ID would not change the foundation
configuration and would be a misleading review gate. The fixed
`foundation_setup` request currently has no reviewed configuration delta to
publish; it deliberately remains platform-authored.
Without all six `AGENT_GUARD_TERRAFORM_*` environment values (repo, dedicated
GitHub read token, distinct runner and approval keys, expected AWS account ID,
fixed runner ID), this area reports disabled.
Do not enable it with development keys or claim an executable infrastructure
workflow: protected runner deployment/dispatch, the actual state-bucket
bootstrap, full independent run observation, drift and
teardown controls are still outstanding. The operator handoff is in
`docs/rizz-ai-terraform-runner.md`.

Before any portal Apply/Destroy button is enabled, a designated runner with
separate AWS authority must create a saved plan for a reviewed configuration
commit, privately retain the artifact, expose only its sanitized summary,
verify a distinct platform approval of that exact binding, recheck source,
variables, backend and state, and apply the saved artifact once. A changed or
expired plan needs a new review. Bootstrap state and IAM/OIDC setup are
operator prerequisites; app retirement and residual inventory are prerequisites
for a separately approved foundation destroy. The platform skill's
`rizz-idp-terraform.md` remains the full acceptance contract.
The agreed US$5 maximum and four-hour checkpoint require a fresh estimate
before a live run; neither the variable bound nor a budget alert enforces a
hard spending cap.

HashiCorp documents that saved plans can contain sensitive data and that
`terraform apply <saved-plan>` executes that plan without another prompt:
[plan command](https://developer.hashicorp.com/terraform/cli/commands/plan),
[apply command](https://developer.hashicorp.com/terraform/cli/commands/apply).
No plan artifact or state file belongs in Git or a Backstage response.
