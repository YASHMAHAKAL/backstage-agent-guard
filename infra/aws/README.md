# Reviewed AWS foundation — local Phase 3 preparation

Code is prepared locally; nothing in this directory has been applied to AWS. Region is `us-east-1`; identity is the separately configured non-root `rizz-platform` profile. Never fall back to the default/root profile. State/ECR/OIDC and EKS/network code are prepared; Argo/controller installation and cloud app deployment remain unfinished.

## Separate state/ownership roots

| Root                   | Owns                                                                                                  | State and retention                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bootstrap`            | Versioned/encrypted/private TLS-only S3 state bucket                                                  | Initially local state; securely back up off-repo. Bucket has prevent-destroy and no force-delete.      |
| `registry`             | Two immutable ECR repos, publisher IAM role, optional new GitHub OIDC provider, monthly budget alerts | S3 backend, encryption and native lockfile enabled; state key isolated from future EKS root.           |
| `environments/staging` | VPC/EKS/access/managed add-ons/secret metadata                                                        | Separate S3 key; [configuration and remaining gates](environments/staging/README.md). Not provisioned. |

Do not run the old Rizz.AI Terraform root or import/duplicate existing resources blindly. Local source CI no longer applies it; remote workflow replacement is still unpublished. These new names are deliberately `rizz-staging-*`, not the legacy `rizz-app`/`rizz-backend`/`rizz-cluster` names. Preflight must still reconcile any existing Rizz deployment and Terraform state before a fresh foundation is authorized. The bounded script now checks new/legacy ECR and EKS names and project VPC Name tags, in addition to registry/bootstrap metadata; it is not a full cloud inventory. Passing it does not prove state ownership or the absence of untagged/renamed resources. See the [current cost and preflight checklist](../../docs/rizz-ai-cloud-preflight.md).

## Local validation, no AWS calls

```bash
terraform -chdir=infra/aws/bootstrap init -backend=false -input=false
terraform -chdir=infra/aws/bootstrap validate
terraform -chdir=infra/aws/bootstrap test
terraform -chdir=infra/aws/registry init -backend=false -input=false
terraform -chdir=infra/aws/registry validate
terraform -chdir=infra/aws/registry test
terraform -chdir=infra/aws/environments/staging init -backend=false -input=false
terraform -chdir=infra/aws/environments/staging validate
terraform -chdir=infra/aws/environments/staging test
node infra/aws/scripts/preflight.test.mjs
```

Tests use mocked providers and plan operations, not real AWS plans or applies. Provider is pinned and locked; installed/tested CLI is Terraform 1.15.8. Review upgrades before changing those pins. State, saved plans, private `.tfvars`, backend configuration and `.terraform` are ignored. The committed examples use dummy account IDs/email/repo names.

## Provisioning gates — do not skip

1. Agree numeric total demo spending target and run window; budget notifications are account-wide monthly alerts, not a hard cap or automatic cleanup. Other account usage counts. Bootstrap/ECR/state retention can still incur costs even without EKS.
2. Confirm target profile/account, permissions and lack of root identity. Inspect named/legacy resources and actual state. Access denied means **unknown**, not absent. Resolve resource ownership/import/migration before planning.
3. Verify GitHub repo/branch and actual OIDC `sub` format privately. Current GitHub formats may include immutable owner/repo IDs. Supply the exact subject; no wildcard, PR or environment subject is accepted. Inspect existing shared provider and its `sts.amazonaws.com` audience before choosing reuse or explicit creation. Never create a second provider blindly.
4. Fill ignored `terraform.tfvars` using each root's placeholder example. Alert email is sensitive in CLI display but still enters protected Terraform state. No application key/password enters these variables.
5. For read-only bounded metadata checks, set private `RIZZ_AWS_EXPECTED_ACCOUNT_ID` and `RIZZ_AWS_STATE_BUCKET` locally, then run `node infra/aws/scripts/preflight.mjs` only when authorized. It emits status labels, not identifiers/secrets. A bucket 404 does not establish availability/ownership; a present bucket needs state/ownership reconciliation. Its `safeToReviewPlan` output means eligibility for human plan review only—not permission to initialize a remote backend, apply, import or destroy.
6. After separate approval, bootstrap init can use local state. Generate a saved plan with `-input=false`; review exact resources/account/region/cost/scope before requesting apply authority. Keep plan/state backups private and never upload to public build artifacts. Explicitly apply that reviewed plan only; no auto-approve commands or app CI apply exists here.
7. After bucket verification, copy the registry backend example to ignored `state.backend.hcl`, fill the verified bucket/profile/account, and initialize the registry backend with that file. Do not use `-migrate-state`, import or overwrite existing state without a reviewed reconciliation step.
8. Generate/review the registry saved plan. Obtain distinct authorization to apply it. Verify native remote locking/version recovery and actual IAM trust after provisioning. No actual lock or recovery test has happened yet.

This README intentionally does not give an automatic apply command. Editing code or passing mock tests does not grant provisioning authority. Argo/controller configuration is [prepared separately](../cloud-platform/README.md); it has not been installed, published or deployed.

## CI publishing boundary

The opt-in source publishing workflow and authenticated read-only adapter are now [implemented locally](../../docs/rizz-ai-release-publishing.md), not activated. An optional dedicated reader role is separate from the publisher; its exact reviewed principal is required before role creation.

Publisher may obtain ECR auth and upload/read/describe only the exact frontend/backend repos. It has no EKS, S3 state, IAM management, Terraform or image-deletion permissions. Login alone needs `Resource: "*"`; image permissions are repo-scoped. IAM `sub` constrains repository/branch, **not a specific workflow file** with the default GitHub subject. Trusted branch writers can modify workflows and are part of the trust boundary; protect/review those files. The later metadata verifier also requires its allowlisted publishing workflow and successful run. Do not claim that workflow-path checking grants IAM-level isolation.

Tagged release images are retained for reviewed rollback, so costs can persist; only untagged build remnants expire after seven days. ECR scan-on-push is supplemental—it is not a proven passing CI scan or complete language-dependency scan. No publishing workflow is activated yet. Real publishing, artifact binding/retention and release adapter must complete Phase 2 after this bootstrap is authorized.

## Teardown

Read the [scoped teardown runbook](TEARDOWN.md) before starting paid infrastructure.

Future EKS teardown must remove controller-owned ALBs while controllers still work, then destroy only the approved cluster/network scope. Registry has no force-delete: retaining or deleting tagged image pairs requires an explicit decision. Shared OIDC provider and state bucket are protected from normal destroy. Keep state/version recovery; do not delete the state bucket just to finish a demo. Review residual billable resources and record what was removed/retained. No teardown is authorized or executed here.

Sources checked during preparation: [Terraform S3 state/locking](https://developer.hashicorp.com/terraform/language/backend/s3), [GitHub AWS OIDC subjects](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [AWS provider OIDC](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_openid_connect_provider), [Terraform mock providers](https://developer.hashicorp.com/terraform/language/tests/mocking).
