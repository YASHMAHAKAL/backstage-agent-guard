# Terraform Actions handoff — prepared, not activated

The [reviewed-run workflow](../.github/workflows/terraform-reviewed-run.yml) is
an opt-in GitHub-hosted runner for a **single** registry or EKS staging saved
plan. It is inert unless the repository variable
`RIZZ_TERRAFORM_RUNNER_ENABLED` is exactly `true`; do not set that variable
until the AWS/state/backend gates below are satisfied. The ordinary
[Terraform checks](../.github/workflows/terraform-checks.yml) have no AWS
authority and run for every PR so they can be required on protected `main`.

This workflow never runs on a pull request. Only a `YASHMAHAKAL` dispatch on
`main` is eligible for the `terraform-apply` environment; GitHub requires
`mystic-koragg` to review the environment job and prevents self-review. This
is **account separation, not independent two-person governance**, since the
two accounts are operated by the same person. A reviewed configuration PR is
a separate gate. The environment approval occurs **before** the executable
plan exists, so it is not a substitute for Backstage's later approval of the
exact plan digest.

## One-job plan and apply boundary

The job builds the reviewed runner, prepares ignored mode-0600 backend and
variable files, and uses GitHub OIDC to assume a distinct Terraform role in a
named AWS profile. It checks the expected account and reviewed merge commit,
then creates a private saved plan in the GitHub-hosted runner's temp directory.
Only a sanitized action summary and hash-bound plan identity go to Backstage.
The job waits up to 24 minutes for a different, currently authorized platform
user to approve that exact plan. A rejection, expiry, changed PR/state/input,
wrong runner or unavailable Backstage endpoint fails closed. The job fetches
the signed receipt again immediately before the single-use saved-plan apply.
It never replans under the old approval, uploads raw state/plan as an artifact,
or runs on a public PR. The runner's `applied` callback is not independent AWS
readiness proof.

The plan and apply must stay in the **same hosted job** because runner-local
saved plans should not cross a public repository's artifact store. A timeout
after the single-use claim is ambiguous; investigate state/run identity and
make a new request/plan rather than retrying blindly. Terraform's 30-minute
plan expiry and the 55-minute workflow timeout are demo bounds, not promises
that an EKS create will finish within them.

## Prerequisites before anyone enables the workflow

1. Keep `main` protected: a reviewed PR, current passing Terraform checks,
   stale-review dismissal and latest-push approval are currently configured.
   Verify the four existing required check contexts. After this workflow and
   CODEOWNERS file are reviewed and merged, verify the new runner-contract
   check has passed on `main`, add it to required checks, and enable required
   code-owner review. No administrator bypass, force push or deletion should
   be used for protected platform authority.
2. Complete the separate, explicitly approved AWS bootstrap for private,
   versioned, encrypted S3 state and verify existing resources/state. Set the
   exact reviewed backend HCL and Terraform tfvars as GitHub **environment
   secrets**, not repo files. Both roots must use the fixed
   `rizz-terraform-runner` profile and the expected account ID. A plan is not
   meaningful until the backend exists and state ownership is reconciled.
3. Create a separate least-privilege Terraform OIDC role only after reviewing
   its actual AWS permissions and GitHub token `sub`/`aud` claims for this
   repository and `terraform-apply` environment. Do not reuse the ECR image
   publisher role or trust a wildcard PR/ref. Current GitHub subject formats
   may contain immutable owner/repository IDs; capture the actual claim
   before writing IAM trust.
4. Make the local Backstage backend securely reachable to a GitHub-hosted
   runner at a bare HTTPS origin. `localhost` on GitHub's runner is **not** the
   user's laptop. Issue a dedicated Backstage service token restricted to
   `agent-guard`, with the separate runner and approval HMAC keys already
   configured in the backend. Do not expose a development token or unauthenticated
   Backstage endpoint through a temporary tunnel.
5. Configure these only in the protected `terraform-apply` environment:
   `RIZZ_BACKSTAGE_RUNNER_SERVICE_TOKEN`, `RIZZ_TERRAFORM_RUNNER_KEY`,
   `RIZZ_TERRAFORM_APPROVAL_KEY`, `RIZZ_TERRAFORM_RUNNER_ROLE_ARN`,
   `RIZZ_TERRAFORM_REGISTRY_BACKEND_HCL`, `RIZZ_TERRAFORM_REGISTRY_TFVARS`,
   `RIZZ_TERRAFORM_STAGING_BACKEND_HCL`, and
   `RIZZ_TERRAFORM_STAGING_TFVARS`. Set the environment/repository variables
   `RIZZ_BACKSTAGE_RUNNER_URL` and `RIZZ_AWS_ACCOUNT_ID` to verified values.
   Backend configuration must expect runner ID `github-terraform-apply-v1`.
   The workflow uses its short-lived read-only `GITHUB_TOKEN` for PR checks.
6. Test denied paths before activation: wrong branch/actor, no GitHub review,
   missing service token, wrong account, unreviewed PR, mismatched request
   root/commit, rejected/expired Backstage plan, swapped plan bytes, changed
   state, and replay. Exercise the full flow in an isolated account only with
   explicit authority. Do not use a live AWS plan as the first test of the
   bridge.
7. Re-estimate EKS, workers, NAT, ALB, EBS, ECR and traffic for the agreed
   US$5/four-hour checkpoint, prepare a teardown operator and residual-resource
   checklist, then request separate authorization for each actual saved
   plan. A budget alert is not a hard spending cap.

The source workflow alone does not create an AWS role, state bucket, secure
Backstage endpoint or cloud infrastructure. It does not implement Terraform
destroy or drift; those remain separately reviewed work. Do not describe the
portal's `runner_reported_applied` state as verified EKS readiness.

References: [GitHub OIDC AWS claims](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[Terraform saved-plan automation](https://developer.hashicorp.com/terraform/tutorials/automation/automate-terraform),
[EKS pricing](https://aws.amazon.com/eks/pricing/).
