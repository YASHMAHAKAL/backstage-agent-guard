# Governed Rizz.AI release portal

## IDP Control Center increment

The Rizz.AI System and its two Components now receive a **Rizz.AI Control
Center** Catalog tab through the new frontend entity-content extension. It
reads the existing authenticated capability, release and scoped proposal APIs;
it shows real data when configured, fixture/disabled/unavailable states when
not, and offers an explicit read-only delivery observation for a selected
proposal. It never infers a deployed release from a configured target, a CI
artifact, or Scaffolder task state. The existing `/rizz-releases` and
`/rizz-deployments` pages remain functional.

Opt-in `app-config.rizz-local.yaml` now also registers platform-owned Resource
entities for the EKS target, staging namespace and paired ECR registry. The
Rizz.AI source catalog descriptors reference the namespace/registry from both
Components. Those catalog Resources carry a planned annotation; registration
does not mean the AWS resources were created. The cloud example overlay repeats
the Kind, org and Rizz.AI locations because catalog location arrays replace
earlier overlays when it is loaded last. Run `node .yarn/releases/yarn-4.13.0.cjs
start:portal` from the platform repository to see the tab; the existing cloud
overlay and credentials are required only to activate live cloud requests.

The ignored local user catalog now maps the confirmed GitHub identities to
`rizz-team` and `platform-team`, while retaining both Kind demo memberships.
New cloud release/runtime requests freeze app-or-platform
review eligibility into a versioned digest; older requests remain platform-only.
The Rizz.AI System, frontend, backend and API descriptors in the source
repository are application-owned by `rizz-team`. The cloud target and
infrastructure Resources stay platform-owned. The runtime replica-change path
is implemented locally. The Control Center now records an immutable
first-success deployment history entry when an authorized read verifies the
exact merged files, Argo sync, both workloads and smoke checks. It does not
turn a CI build into a rollback candidate or initiate sync. A bounded rollback
proposal path is now implemented locally; staged retirement is also wired
locally, while Terraform controls and a live EKS deployment are not. A private backend metrics observer is wired
locally; its EKS Service proxy access still requires the separately reviewed
observer RBAC and live cluster authorization.

The Control Center now labels release, runtime-change and rollback proposals separately,
links authorized submitters to the corresponding working form, and deep-links
each visible proposal to its exact review entry. Its access card uses the
authenticated capability response to show current submit permission and the
actual app/platform reviewer groups. Group membership alone is not approval;
the backend still checks each distinct reviewer at decision and execution.
New requests require server-verified application catalog ownership; historical
platform-only proposals keep their original frozen review policy.

The backend includes a **read-only runtime-change preview**.
It validates a strict `runtime_change` replica patch (integers 1–2), checks a
complete pinned GitOps baseline and preserves unchanged file bytes. The
authenticated reader can return those verified bytes from the same Git tree.
There is now a separate version-2 frozen runtime snapshot binding the exact
baseline and proposed files, authenticated-context fields, template/policy
version, changed fields and digest. The authenticated `POST
/api/agent-guard/rizz/runtime/preview` route reads the current configured
target and pinned GitOps bytes, then returns a before/after replica summary,
changed file hashes or an explicit no-op. It rejects guest/outsider identities,
invalid patches and absent/unsupported baselines. It does not persist a
proposal, call Jev or dispatch Scaffolder. The separate authenticated
`POST /api/agent-guard/rizz/runtime/proposals` route and MCP
`submit-rizz-runtime-change-proposal` action call Jev, record a version-2
frozen snapshot and enter the distinct-review lifecycle. The portal previews
before enabling submission. Approval, dispatch and publication revalidate the
exact pinned baseline; the private Scaffolder action receives only task-bound,
backend-owned bytes. The agent has submission/status actions, not approval or
direct execution. Existing version-1 release proposals retain their original
snapshot and validation paths.

The authenticated rollback form lists only recorded *verified release
deployments*, not builds or runtime-change records. Preview re-resolves the
exact retained paired release, reads the current pinned GitOps tree, and
rejects absent, unsupported or no-op baselines. It permits only the prior
image pair and bounded replica counts to change; ingress, routing, secret
references and other manifests must remain byte-for-byte compatible. Submit
calls Jev and freezes the selected deployment evidence into a version-3
approval digest. A distinct eligible reviewer is required. The private
publisher opens an exact-base **draft PR**; it never runs `git revert`, merges,
syncs Argo or touches Kubernetes. Approval and publication recheck retained
evidence and current protected configuration. `POST
/api/agent-guard/rizz/rollback/preview` is read-only; `POST
/api/agent-guard/rizz/rollback/proposals` and the MCP
`submit-rizz-rollback-proposal` action only submit proposals.

History recording is observation-driven: an authorized delivery refresh must
see independently verified merge, Argo sync, both workloads and smoke checks.
There is no background poller yet. Newly published release artifacts expire
after 30 days and the recent-release browser scans three runs, so long-term
rollback availability is **not** guaranteed. If evidence expires or protected
configuration changes, rollback fails closed and requires a fresh eligible
release or reviewed migration; it is not a Terraform rollback.
See [the rollback runbook](rizz-ai-rollback-runbook.md) for the recovery flow
and verification criteria.

## Implemented versus live

The cloud portal is available at `/rizz-deployments`, with a Backstage navigation
entry and a link from `/rizz-releases`. The Kind workflow stays at `/agent-guard`.
Default startup registers no cloud target and no cloud MCP actions. The page
shows an explicit disabled state and does not query AWS, Jev or Scaffolder.

This local implementation adds the portal, configuration adapter, opt-in
Template, release path, bounded runtime replica-change path, rollback proposal
path and staged retirement proposal/publisher/observation path.
It does **not** provision the foundation, enable CI publishing, create real ECR
images, configure repository protections, open a PR or deploy to AWS. Tests use
synthetic transports. UI tests exercise rendering/events; no browser screenshot
or live cloud success is claimed.

## Prerequisites before opting in

1. Explicitly authorized AWS foundation and add-ons exist; separate Terraform
   state/ownership, cluster, Argo project/application and private repository access
   have been verified. No release template runs Terraform.
2. The restricted-IP ALB and ready-stage self-signed certificate bootstrap have
   completed. See `rizz-ai-alb-demo.md`. Target fields must come from observed
   outputs, not this example. Changing the hostname/certificate or unsupported
   existing app configuration needs a separate reviewed migration.
3. Real trusted CI has published a retained paired release, with successful
   checks and both immutable ECR images. No fixture or mutable-tag fallback.
4. A dedicated cloud-reader AWS profile has the read-only permissions listed in
   `rizz-ai-cloud-phase-4.md`. The ECR-only release-reader profile is separate;
   neither is the infrastructure admin. Never use root.
5. GitHub credentials: release evidence token, GitOps read token and Backstage
   publisher credentials remain backend-only. The publisher uses the existing
   GitHub integration credential provider; restrict it to the intended GitOps
   repository with contents/PR write, never cluster or Terraform access.
6. Real catalog users/groups have been mapped. Choose actual submitter groups.
   A **different** authenticated rizz-team or platform-team member must be
   available to review new routine app proposals. Historical cloud proposals
   retain their platform-only review policy.
   This configuration grants no invented group memberships.
7. Install the offline check bundle in `infra/cloud-gitops/README.md` and separately
   configure/verify merge protections for the GitHub plan in use. Opening a draft PR does not enforce
   repository approval against a trusted maintainer.

## Configuration

Use private, ignored local overlays rather than editing default Kind config.
The committed examples are documentation, not ready-to-run account settings:

- `app-config.rizz-releases.yaml.example`: real source repository/paired registry
  paths, release-reader profile and `${RIZZ_RELEASE_GITHUB_TOKEN}`.
- `app-config.rizz-cloud.yaml.example`: disabled by default. Set actual account,
  source/GitOps repositories, observed ALB hostname/operator `/32`, ready ACM ARN
  and fingerprint, explicit submitter groups and dedicated cloud-reader profile.
  `${RIZZ_GITOPS_READ_TOKEN}` is a read-only backend token.

Create `app-config.rizz-cloud.local.yaml` only when preparing that explicit
configuration; it is ignored by Git. Do not commit tokens, operator details or
local certificate keys. Keep secret values in ignored env files or an approved
secret store, never in template parameters. Example interpolation may require
the named environment variables even if `enabled` is false when loading the
overlay; normal default startup does not load this file.

The overlay includes the catalog location for the private
`template:default/deploy-rizz-ai` executor. Loading it while governance is disabled
may make the template visible in Catalog, but it still cannot be executed by an
ordinary user and no cloud proposal is allowed. Enable governance only when all
prerequisites are met. Allow catalog refresh before using the form.

For an already-reviewed, configured environment, Backstage's named environment
loading picks up the private `app-config.rizz-releases.local.yaml` and
`app-config.rizz-cloud.local.yaml` overlays. The explicit cloud profile is
**not a command to run before provisioning**:

```sh
node .yarn/releases/yarn-4.13.0.cjs start:portal:cloud
```

The ordinary `start:portal` profile does not load either cloud overlay. Both
profiles load the base configuration automatically; no `--config` flags are
needed. Cloud remains disabled unless its private overlay explicitly enables
it. The cloud startup script refuses to start if either required private file
is missing; this avoids silently running the wrong profile.

Registry/source/account mismatch, missing credentials or unsupported target
configuration fails closed. Construction/startup does not perform provider
reads; capability lookup checks mapped user, owner and registered template, not
live readiness. Proposal submission performs fresh live verification.

## Manual and MCP workflow

1. Sign in and open **Rizz.AI deployments**. The capability endpoint identifies
   the configured EKS target without claiming readiness. No AWS flag repoints Kind.
2. An authorized submitter selects a verified, unexpired paired release, writes
   declared intent and chooses frontend/backend integer replicas from 1–2.
   Owner, images, destination, exposure and runtime settings are not free-form
   inputs. Only proposal creation occurs on submission.
3. Backend authenticates and authorizes the caller, verifies the exact catalog
   template, independently resolves release/target/current GitOps evidence,
   freezes all files and calls Jev. Unavailable/mismatched evidence prevents normal
   approval. UI displays Choice/Noul/Score as advisory, not authorization.
4. A distinct eligible rizz-team or platform-team reviewer opens the scoped queue, checks paired image
   digests, source/record, account/cluster/namespace, frontend restriction,
   certificate fingerprint, private backend, reviewed base and exact generated
   bytes/hashes. Checkbox confirmation is an interface aid, not a separate
   cryptographic human-presence proof. Backend reviewer authorization is enforced.
5. Approve/reject sends only the exact digest and decision. Approval freshly
   revalidates template/target/release/base and starts the private Scaffolder task.
   Direct task creation and dry-run remain denied. A changed template fails before
   execution; the recipe's publisher action/version is pinned by exact spec checks.
6. Scaffolder obtains frozen backend files via its task-bound claim and opens at
   most one exact-base **draft** GitOps PR. Task identity is visible in Agent Guard;
   service-created task logs are restricted, not exposed through browser links.
7. A human checks the unchanged reviewed base and required PR checks, marks the
   draft ready and merges. Argo CD may then reconcile. No page refresh triggers
   sync, Terraform or cluster mutation.

MCP uses `submit-rizz-release-proposal` / `get-rizz-release-proposal-status` from
official Backstage Actions. There is no MCP approval/execute tool. Backend records
MCP intent as `agent_supplied`; REST submission as authenticated user-submitted,
neither proving the original human words. Reconnect MCP after activating the
configured action set if necessary.

For an existing complete Rizz.AI GitOps deployment, the portal's **Change runtime
replicas** form or the MCP `submit-rizz-runtime-change-proposal` action accepts
only `operation: runtime_change`, `targetId: eks-staging`, declared intent and
an optional frontend and/or backend replica count (each 1–2). At least one
count must change. It does not accept images, routing, model, manifests,
Terraform or target details. The reviewer sees before/after counts, preserved
configuration, exact proposed bytes and digest. The
`get-rizz-runtime-change-proposal-status` action is read-only. A merged runtime
PR still needs independent GitHub, Argo, EKS rollout and HTTPS evidence before
the portal reports deployment verified.
The current runtime submission verifies the target and pinned desired-state
baseline, but does not yet require a healthy observed rollout as a precondition;
operators should check the delivery panel before treating a scale request as a
live capacity change.

## UI and failure behavior

- Review queue is requester/platform-member scoped by the backend. The browser
  never chooses requester identity or decides who may review.
- Current desired image pair/replicas/model are shown separately from proposed
  release. Generated files are exact proposed bytes, **not** a live-cluster diff.
  Current base file hashes are available for audit. A visual line diff is not yet
  provided.
- Jev gauges reuse the established professional Agent Guard UI, including rubric
  and probability disclosures. No operational-risk or approval guarantee is added.
- Fixture/expired/unavailable releases disable submission. Release-source failure
  does not hide an otherwise readable existing review queue.
- Refresh clears stale data/confirmation. An ambiguous POST disables further
  action until refresh; no automatic mutation retry or raw provider error is shown.
- Delivery section distinguishes task/PR handoff from **deployment not verified**.
  The separate read-only panel checks authenticated GitHub merge/file evidence
  and dedicated cloud Argo source/destination/revision, then independently reads
  both EKS rollouts/running images and performs certificate-verified HTTPS
  health/readiness checks. Only all four stages passing verifies delivery.
  Do not reuse the Kind observer as proof of cloud rollout. See
  `rizz-ai-cloud-observation.md` for the read-only IAM/RBAC prerequisites.

Next: explicitly authorize/review the short AWS run and required access, install
real checks/merge controls, build the paired release and demonstrate deployment
verification, recovery and teardown.
No cloud milestone exit is claimed until the actual rollout evidence exists.

API/configuration references verified against installed types and
[Backstage template docs](https://backstage.io/docs/features/software-templates/writing-templates/)
and [configuration definitions](https://backstage.io/docs/conf/defining/).
