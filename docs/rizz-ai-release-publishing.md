# Trusted paired releases — implemented locally, not activated

This increment adds the source publishing workflow and Backstage read-only GitHub/ECR adapter. No workflow was pushed/dispatched, image published, AWS resource provisioned or live Gemini/Jev call made. Existing Kind template/proposal behavior is unchanged. The cloud deployment form/template remains disabled/unimplemented.

## Repository boundaries

Rizz.AI owns `.github/workflows/publish.yml` and `scripts/create-release.mjs`/tests. No application source is copied into Backstage. Platform repo owns verifier, backend-only configuration, optional reader-role Terraform and tests. GitOps repository is untouched: publishing a build never deploys it.

## Publisher behavior

The workflow targets the verified local source branch `master` only, on push or explicit dispatch. The whole job requires operator repo variable `RIZZ_ECR_PUBLISH_ENABLED=true`; absent/false means no publishing job or AWS session. No PR/workflow-run trigger, app Git push token, Terraform, kubectl or Argo invocation.

Order: exact source commit checkout → release-generator tests → backend/frontend tests and npm dependency audit → both images built and **explicit mock-only** Compose smoke check → digest-pinned Trivy HIGH/CRITICAL vulnerability gate → short ECR-only OIDC session → tag/push those same scanned images → fetch exact stored ECR manifests → create paired release JSON → immutable GitHub artifact. The mock server is a mounted test fixture, not included in the backend production image. This is not a live Gemini functional test.

Both images use immutable tag `<commit>-<run_id>-<run_attempt>` in `rizz-staging-frontend`/`rizz-staging-backend`. Generator binds each ECR manifest hash to its reported digest and `config.digest` to the Docker image ID in that component's scan report. Wrong account/repo/scanned image/digest, incomplete reports or HIGH/CRITICAL vulnerabilities reject the record. `checks: passed` describes successfully gated CI steps; it is not fabricated model output or independent authority. Backend separately checks actual successful job/step conclusions.

Single `release.json`, artifact `rizz-release-<run_id>-<attempt>`, ZIP archiving explicitly true, overwrite false, 30-day retention/record lifetime. Generator creates output exclusively, not overwriting an existing file. Failure after the first image push may leave one tagged image; **no eligible pair record** is emitted. Retry via a new reviewed run attempt/tag, never overwrite an immutable tag or fabricate missing-image success. Retained/orphaned tags require explicit cleanup decisions.

SHA-pinned actions: existing checkout/setup-node, configure-aws-credentials v6.3.0, upload-artifact v7.0.1. Credentials action uses fixed region, exact allowed account, 15-minute session, masked account logs and disabled automatic retries. Scan happens before the normal credentials step, but this is **workflow ordering, not IAM enforcement of step completion**: the OIDC role still trusts the exact repo/branch subject, not the workflow path. Trusted branch writers can alter workflows/use that role and remain part of the trust boundary. No cryptographic build attestation is claimed.

## Backend verification

`releaseSource.ts` is enabled only by backend operator configuration. Authenticated GET `/api/agent-guard/rizz/releases` and `/rizz-releases` UI remain read-only; no record-upload, image-push or cloud-deploy API is added.

For the latest **three successful publisher runs** only:

1. Verify AWS CLI caller is the expected account's **assumed `rizz-staging-release-reader` role**, never root/default/operator role.
2. Fetch allowlisted workflow on `master`; verify source/head repository IDs and names, commit, event, attempt, path and successful completion. Fork/PR candidates are ignored.
3. Require exactly one nonexpired artifact matching run and attempt, with matching independent run/repository/commit metadata; read actual publish-job and required step conclusions for that exact attempt.
4. Use authenticated GitHub API download redirect. Allow HTTPS approved Azure/GitHub artifact-storage suffixes only, no URL credentials/ports/further redirects. Never forward the GitHub Authorization header to storage or expose signed download URLs.
5. Bound ZIP download to 128 KiB and JSON to 64 KiB; require exact single `release.json`, no extraction, symlinks/encryption/paths. Verify ZIP SHA-256 against **GitHub API artifact digest**, not a hash declared by the agent.
6. Strictly parse record and match run/attempt/commit; read both exact approved ECR digests and verify stored manifest bytes hash correctly. Existing policy checks source/ref/workflow, paired commits, registry allowlists, expiry and canonical record digest.

Maximum three runs, bounded API payloads, per-request/CLI timeouts and 20-second overall signal; concurrent refreshes coalesce only while in flight. No cached green fallback. Missing/invalid independent evidence or transport failure returns sanitized unavailable/empty listing. Recent runs with no pair artifact produce no release. A removed/expired artifact or image cannot become trusted via a mutable tag fallback. Three-run browsing is **not an exhaustive rollback catalog**; phase 4 needs a bounded exact-release resolver/revalidation before executable proposals.

Trust level is authenticated CI artifact + successful allowlisted workflow/steps + exact existing registry manifests. This is the agreed minimum provenance binding, not signed SLSA provenance, proof against compromised trusted CI/branch writers, freshness of vulnerability databases, or authorization to deploy. Live API compatibility and actual scan/push success remain untested.

## Separate read-only identity

Optional `infra/aws/registry/release-reader.tf` creates a role only when a reviewed same-account non-root IAM principal is supplied. Trust is exact `sts:AssumeRole`; sole permission is `ecr:BatchGetImage` on the two registry ARNs. No ECR login/upload/delete, EKS, state, secrets or IAM mutation permission. Existing operator needs reviewed permission to assume it.

After authorized provisioning, configure a private AWS CLI profile `rizz-release-reader` with `source_profile=rizz-platform`, verified output `role_arn` and region `us-east-1`. Renewable authentication is handled outside Backstage; expired credentials fail closed. Don't add access keys to Backstage config, create a root-backed profile or use the publisher role for read-only portal access.

## Activation gates — not performed here

1. Agree numeric budget and review/apply state/registry/reader-role plans with explicit authorization, reconcile legacy resources/OIDC and verify actual branch token subject. EKS need not be running while testing publishing.
2. Review/publish app changes, including retiring the old direct Terraform/kubectl deploy workflow. Its deletion is local/unpublished; do not leave competing delivery ownership enabled remotely. Inspect/cancel any legacy in-flight run only with authority.
3. Set app repo variables privately: verified `RIZZ_AWS_ACCOUNT_ID`, `RIZZ_PUBLISH_ROLE_ARN` from Terraform, and **only when authorized** `RIZZ_ECR_PUBLISH_ENABLED=true`. Enabling affects subsequent master pushes as well as dispatch. No credentials/keys in repo variables. OIDC may fail closed on subject mismatch; do not broaden trust to fix it.
4. Authorize one real publisher run. It uses GitHub runner/artifact quotas and AWS registry storage/transfer; neither free billing nor a successful current image scan is assumed. Resolve gate failures without lowering vulnerability policy merely to finish a demo.
5. Create a dedicated source-repo GitHub credential with Actions read/metadata access, preferably a fine-grained token/App; put `RIZZ_RELEASE_GITHUB_TOKEN` in the project's ignored backend `.env`, never paste it in chat or browser config. Don't reuse a broader GitOps-writing credential by default.
6. Copy `app-config.rizz-releases.yaml.example` to ignored `app-config.rizz-releases.local.yaml` and fill verified source/registry metadata. Use `node .yarn/releases/yarn-4.13.0.cjs start:portal:releases`; its `BACKSTAGE_ENV` profile loads the private release file without extra `--config` flags. Token uses environment substitution and secret schema visibility. CLI and named reader profile must be available to the backend process. Ordinary `start:portal` remains unconfigured and performs no release API calls.
7. Sign in, visit `/rizz-releases`, refresh and inspect source commit/both digests/expiry. Verify deletion/expiry/outage fail closed later using explicitly scoped authorized tests. This does not create a proposal, PR or deployment.

No activation variables, credentials, AWS profiles, private config or remote repo settings were changed here.

## Local verification

```bash
# Platform checkout (mock transports, no real GitHub/ECR requests):
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-agent-guard-backend test --watch=false --runInBand
RIZZ_APP_CHECKOUT=/absolute/path/to/Rizz.AI node infra/cloud-platform/publishing-contract.test.mjs
terraform -chdir=infra/aws/registry test
# App checkout (synthetic scan/registry fixtures):
node scripts/create-release.test.mjs
```

Tests cover altered artifact/attempt/repository metadata, missing required CI steps, unsafe redirects, root reader, wrong manifest, ZIP bombs/paths, config opt-in, expiry and no stale cache. Fixture outputs are never installed as a production release source. Workflow was checked locally as YAML plus shell syntax; no GitHub Actions execution is claimed.

Observed local results for this increment: 80 backend tests passed (one existing skipped), eight registry Terraform mock tests passed, four app record-generator fixture tests passed, and one publisher YAML/shell-contract test passed. Workspace TypeScript checking and backend lint passed. Dependency installation retained existing workspace peer warnings; no unrelated dependency upgrade was made.

Next: bounded exact-release resolution and governed `deploy-rizz-ai` template/form with target/owner policy, frozen files, distinct review and cloud observations. Keep this unregistered until those execution guards exist; no arbitrary digests or raw manifest upload from an agent.

Primary sources checked: [GitHub artifacts/digests](https://docs.github.com/en/rest/actions/artifacts), [workflow runs/attempt jobs](https://docs.github.com/en/rest/actions/workflow-runs), [ECR BatchGetImage](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_BatchGetImage.html), [pinned AWS credential action](https://github.com/aws-actions/configure-aws-credentials/tree/e1253824e5c10ff9df46874f81ed3ec929e19cfd), [pinned artifact action](https://github.com/actions/upload-artifact/tree/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a), [bounded ZIP reader](https://github.com/thejoshwolfe/yauzl).
