# Phase 4 — Governed release path (in progress)

## Implemented locally

- Separate strict `deploy-rizz-ai` request contract: declared intent, exact
  release ID and record digest, explicit `eks-staging` target, and two required
  integer replica counts (1–2). No images, secrets, YAML, owner overrides, repo
  URLs or target connection details can be supplied in this contract.
- Backend-only `ReleaseCatalog.resolve(id, expectedDigest)` freshly verifies
  independent CI/artifact/ECR evidence and compares the selected record hash.
  Fixtures and sources without an exact resolver are never accepted here.
- The GitHub/ECR adapter resolves a single exact run attempt. It does not search
  the last-three-runs browser list, so a retained previous release can be
  resolved independently. The requested commit, run ID and attempt must match.
- Malformed/unsafe IDs are rejected before network or CLI reads. Unknown,
  expired, missing, duplicate or changed records and provider failures fail
  closed without cached success or provider error details.

Exact verification is evidence, **not permission to deploy**. Tests use injected
transport fixtures; no real release, ECR image or AWS resource was created or
queried for this increment.

The adapter uses GitHub's documented [Get a workflow run attempt endpoint](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt).
Both browse and exact resolution retain the existing bounded requests, approved
artifact hosts, archive checksum, successful job-step checks and reader-role
identity checks. Retention still applies: an unavailable artifact/image cannot
be reconstructed or trusted from an old selection.

## Deliberately not activated

No cloud Template entity, MCP action or REST submission handler is registered.
The existing local proposal handler continues to reject `deploy-rizz-ai`.
There is no new deploy button or AWS config overlay. Existing local schemas and
historical snapshots are unchanged.

## Next increments

1. Confirm cloud owner/reviewer mapping and frontend hostname/HTTPS/certificate
   approach. Resolve account/region/cluster/namespace/exposure/GitOps destination
   from explicit platform configuration, never from agent arguments.
2. Deterministically render both digest-pinned workloads and reviewed ingress/
   runtime configuration. Freeze release evidence, target/template/policy
   versions, generated files and current-app GitOps preconditions.
3. Wire manual and MCP proposals to the same authenticated service, compact Jev
   context, distinct authorized review, private task-bound Scaffolder execution
   and concurrency-safe/idempotent GitOps publishing. Revalidate release and
   target evidence before execution.
4. Add the cloud form/template only after the gate and bypass tests pass. Extend
   delivery observation for both workloads and the separate EKS target.

No foundation provisioning, PR publishing or cloud deployment is authorized by
this code increment. Actual AWS use remains a separate reviewed checkpoint.

## Restricted ALB decision and preparation (2026-09-27)

The user selected platform-team ownership, no purchased domain, and restricted-IP
ALB access with temporary self-signed HTTPS. An offline Ingress renderer and
local-only certificate helper are now available. See [the ALB runbook](rizz-ai-alb-demo.md)
for the required two-stage hostname/certificate bootstrap and tests. Nothing was
imported to ACM, applied to Kubernetes or provisioned in AWS. The cloud approval
form/template and live certificate/target verification remain unfinished.

## Frozen cloud recipe increment (2026-09-27)

Implemented backend-only building blocks, not registered submission/execution:

- Strict server-owned EKS target mapping: account/us-east-1/cluster, namespace,
  platform-team owner, source and GitOps repositories, fixed cloud path, Argo
  Application, ready-stage ALB hostname, single operator `/32`, certificate ARN
  and SHA-256 fingerprint. Agent request fields cannot override these values.
- Nine deterministically rendered files: paired digest-pinned Deployments, two
  ClusterIP Services, bounded runtime ConfigMap, SecretStore/ExternalSecret
  references, frontend HTTPS Ingress and a Kustomization. No plaintext Secret,
  namespace creation, catalog duplicate, arbitrary YAML or cloud provisioning.
- Separate `rizz_cloud_release` envelope, preserving historical local schemas
  and hashes. It binds requester/backend-recorded provenance, declared intent,
  recipe/version/hash, parameters, complete verified release record and hash,
  target, policy version, reviewed GitOps base revision/file hashes and every
  generated file's bytes/hash.
- Integrity reconstruction detects missing/extra/changed output or inconsistent
  provenance. Precondition revalidation compares current target/base and freshly
  resolves retained CI/artifact/ECR evidence, rejecting fixture-mode or outages.
  Initial concurrency policy is conservative: **any** main revision movement,
  even an unrelated commit, requires a new preview/review. A future publisher
  must check these preconditions atomically against the intended PR base; a
  read check alone does not eliminate a race with another merge.

Target parsing and pure snapshot construction are not live target verification,
proof of authenticated context, approval or execution authority. Callers must
use server-side credentials/catalog permissions and independent readers. These
functions are not exposed as agent/REST tools. There is no green mock deployment.

Only `ready` ALB configuration is accepted for an application-release snapshot;
bootstrap certificate/Ingress stays in the explicitly reviewed operator setup
procedure. Live certificate SAN/fingerprint/expiry/ARN/cluster/SG checks remain
mandatory and are **not implemented by a config shape check**.

Runtime bounds are per backend process (including provider-call counters), not
a distributed/global Gemini quota; multiple replicas/restarts can increase the
total. No new model selection or runtime override is accepted in the request.

Tests use synthetic identities, account/release/certificate/base evidence and
local process checks. Offline ALB-helper conformance and `kubectl kustomize`
rendering validate output without calling a cluster. No AWS/GitHub/model calls.

The following increment implements the service boundary. Production reader and
publisher adapters, the cloud template and cloud review UI remain separate work.

## Authenticated cloud proposal service increment (2026-09-27)

Implemented and tested with injected synthetic transports, **disabled in the
running app by default**:

- A separate `rizz_cloud_proposals` database table and authenticated REST routes
  under `/api/agent-guard/rizz/proposals`: submit/list/get and explicit decision.
  Unconfigured cloud requests return unavailable; they never fall back to Kind.
- Optional backend-owned `createAgentGuardPlugin({ cloud: ... })` integration,
  requiring GitHub auth mode, strict platform target, explicit submitter groups,
  fresh release resolver and authenticated-reader contract. This is a code-level
  integration point, not an agent option or an environment toggle that invents
  trusted evidence. No default production configuration was added.
- When configured, two MCP actions: `submit-rizz-release-proposal` and
  `get-rizz-release-proposal-status`. No approve/execute/sync action. REST and MCP
  share the service and record their provenance server-side; MCP intent remains
  `agent_supplied`, not verified original human words.
- Non-guest catalog-mapped users only. Submitter membership must match both
  authenticated ownership claims and current catalog relations. Visibility is
  limited to the requester and platform-team members under this original
  version. Review requires a distinct authenticated platform-team member and
  the exact snapshot digest. New proposals now use the versioned app-or-platform
  policy described in `rizz-ai-cloud-portal.md`; old proposals are not widened.
- Compact Jev context describes current-versus-proposed paired workloads,
  replicas, exposure and bounded runtime defaults. It omits AWS account,
  certificate ARN/fingerprint, operator IP and credentials. Semantic mismatch
  or unavailable Jev evidence holds the proposal for clarification. Jev does
  not enforce membership, replicas, target validity or execution authority.
- Fresh target/GitOps reads and retained release verification at submission,
  approval, dispatch and private publish reservation. Readers receive abort
  signals; the service also bounds the combined target/GitOps read to 20 seconds.
  A changed GitOps base, changed/deleted release or provider outage blocks the
  relevant operation. Reviewer catalog membership is checked again before
  dispatch/publication.
- Compare-and-swap transitions prevent concurrent approvals from dispatching
  two tasks. Only the backend passes a random claim as a Scaffolder task secret;
  the public proposal omits its hash. Private service-authenticated reservation
  requires the matching claim and bound task ID, and yields only frozen backend
  file bytes, target, unique branch and reviewed base revision. Execution state
  changes are audited. An ambiguous dispatch failure has no automatic retry.
- Private completion accepts only a PR URL/number in the approved repository.
  This is a trusted publisher callback, **not independent GitHub PR or deployment
  verification**. A later delivery observer must verify actual GitHub/Argo state.

### Remaining integration at the service-only checkpoint

At this checkpoint, `CloudReaders` was an adapter contract, not an implemented live AWS verifier.
Tests provide synthetic authenticated-reader and CI transports; setting their
mode field to `authenticated` alone is not proof of verification. Production
implementations must independently verify AWS identity/cluster, ACM SAN,
fingerprint/expiry, observed ALB and security-group scope, and derive GitOps base
and current configuration from the **same exact authenticated revision**.

The service can request `template:default/deploy-rizz-ai`, but that template is
not catalog-registered yet. No cloud Scaffolder publishing action was installed
at that checkpoint.
Do not activate this optional integration until the real readers and publisher
are complete and tested. The old Kind publishing primitive must not be reused
unmodified: it does not pin the cloud proposal's reviewed GitOps base. The new
publisher must create a unique branch from that exact commit, verify frozen
content/destination, handle partial failures without duplicate publication and
address base movement through enforced PR checks/review. A read followed by a
write is not an atomic guarantee against another merge.

Next: implement the real read-only verification and private publishing adapters;
then register the governed template and cloud form/review UI together. Extend
delivery observation to both workloads on the separate EKS target. No AWS
resource, live cloud PR, image publication or paid Jev/Gemini test was created by
this increment, and no running cloud deployment is claimed.

## Verification and exact-base publisher increment (2026-09-27)

Implemented real API adapters, tested using synthetic transports only:

- `AuthenticatedCloudReaders`: bounded AWS CLI read-only calls using an explicit
  operator-owned reader profile; no shell, root identity, ambient access keys or
  configured endpoint override. Check STS account/non-root identity, active EKS
  cluster ARN and VPC, private API access and restricted public API CIDR, exact
  imported ACM certificate, SAN, actual X509 SHA-256 fingerprint, self-signature,
  validity and at least one hour remaining. No private key is fetched.
- Verify the existing ALB name/hostname/account/VPC, active IPv4 internet-facing
  state and controller cluster/namespace/Ingress association tags. Require one
  HTTPS/443 listener, the reviewed TLS policy and only the approved certificate,
  including the SNI certificate listing. Verify every attached security group:
  only TCP/443 from the one operator IPv4 `/32`; no extra ports, IPv6, prefix-list
  or security-group ingress. The reader must be authorized for all these APIs;
  missing/partial evidence blocks the request.
- GitOps reads resolve `main` once, then fetch its exact commit/tree/blob objects.
  Reject truncated trees, oversized bodies, symlinks/submodules, nested or unknown
  cloud files and unsafe parent directories. Check each blob's Git SHA-1 and
  byte length, then compute approval SHA-256 hashes. Derive semantic current
  state from these same bytes. Only an absent app or the complete existing
  platform-generated JSON/YAML recipe is supported; arbitrary YAML/configuration
  needs an operator-reviewed migration. Full recipe comparison prevents hidden
  resources or runtime/exposure changes from becoming an optimistic summary.
- Existing image digests, replicas, model and exposure are summarized for Jev.
  ECR account/repository strings are omitted from its current-state context.
- A private `agent-guard:publish-rizz-cloud-pr` Scaffolder action is installed
  alongside the unchanged Kind action. It rejects dry-run/missing task claims;
  it has no workspace or agent-supplied publishing fields. The backend provides
  frozen file bytes/hash, target, base revision, unique branch and approval digest.
- `ExactBaseCloudPublisher` uses authenticated GitHub Git Database APIs to overlay
  those nine files on the **reviewed base tree**, create a commit with that exact
  parent and a proposal-specific branch, and open a **draft** PR. No write to
  `main`, merge, deletion or force-push. It checks main/head/base/destination
  before and after publishing and refuses foreign/changed branches or closed PRs.
- Retry uses a deterministic commit identity/date and the same unique branch/PR.
  Timeouts after branch/PR creation are reconciled by authenticated reads; an
  unresolved result remains an error, never invented success. Same task/claim
  may reserve the original plan again only after fresh revalidation. First
  consumption is CAS-protected and audited once; a different task cannot recover
  it. Recovery after approval/release/base changes is intentionally blocked.

### Activation and honest guarantees

These adapters are **not configured or invoked against AWS/GitHub in this
increment**. The app still uses the default plugin with cloud governance disabled.
Backend exports support a later explicit factory configuration. Do not substitute
a fixture transport for a production verifier. The cloud template is still not
catalog-registered; cloud form/review UI, required PR checks and delivery observer
remain unfinished. No external PR or deployment was created.

AWS verification is control-plane/configuration evidence, not a successful
Kubernetes rollout, namespace RBAC check, Argo readiness or application smoke
test. Controller association tags are verified assertions within the trusted
AWS operator boundary, not proof against an AWS administrator forging tags.
The ready ALB/certificate must already exist from the separately reviewed operator
bootstrap; this adapter cannot provision it. Certificate/hostname changes or
unsupported existing GitOps configuration require explicit migration/review.

An exact-base commit prevents silently rendering on a later base. GitHub's API
does not make the main-read/PR-write sequence atomic with other merges. A branch
or draft PR can remain if state changes or a later call fails. Human reviewers
must verify the recorded base and required checks before marking the draft ready
and merging; repository branch/check protections still need to be configured
and verified for the available GitHub plan. Do not claim those protections are
already enforced, or that a draft is an authorization mechanism against trusted
repository maintainers. Partial failures are not automatically force-repaired.

Required reader permissions: `sts:GetCallerIdentity`, `eks:DescribeCluster`,
`acm:DescribeCertificate`, `acm:GetCertificate`,
`elasticloadbalancing:DescribeLoadBalancers`, `DescribeTargetGroups`,
`DescribeTags`, `DescribeListeners`,
`DescribeListenerCertificates`, and `ec2:DescribeSecurityGroups`; GitOps contents
read. Use a dedicated least-privilege role/profile, not the infrastructure admin
or the ECR-only release-reader role. Publisher credentials use Backstage's GitHub
credential provider and require GitOps contents/PR write only, not AWS access.
No reader role or policy attachment was provisioned here.

Sources checked: [GitHub trees](https://docs.github.com/en/rest/git/trees),
[references](https://docs.github.com/en/rest/git/refs),
[pull requests](https://docs.github.com/en/rest/pulls/pulls),
[EKS describe](https://docs.aws.amazon.com/cli/latest/reference/eks/describe-cluster.html),
[ACM public certificate](https://docs.aws.amazon.com/cli/latest/reference/acm/get-certificate.html),
[listeners](https://docs.aws.amazon.com/cli/latest/reference/elbv2/describe-listeners.html),
[security groups](https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-security-groups.html).

Next: explicit disabled-by-default target/reader configuration, governed cloud
template and manual/MCP review UI, required GitOps checks and cloud observation.
Provisioning and a live end-to-end run remain separately authorized checkpoints.

## Opt-in cloud portal increment (2026-09-27)

Cloud configuration, exact private Template validation and the separate
`/rizz-deployments` navigation/form/review page are now implemented. Registration
is through the explicitly loaded cloud overlay; default Kind startup remains
unchanged. Configured capability is not live readiness, and delivery handoff is
not deployment verification. See [the portal setup/workflow](rizz-ai-cloud-portal.md)
for prerequisites, credential boundaries, UI tests and still-unfinished PR checks
and cloud observation. No live AWS target was configured or called in this step.
