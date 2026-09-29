# Rizz.AI staged staging retirement

The portal at `/rizz-deployments#retirement-form` accepts a reason and a
declared intent from an authorized Rizz.AI requester. The backend selects the
next stage from the pinned GitOps tree. Each stage has its own proposal,
approval digest, distinct platform reviewer, private Scaffolder task and draft
GitOps PR. An MCP agent can submit or read a proposal but cannot approve,
publish, merge, sync or delete resources.

## Stage 1: remove public ingress

The first preview requires the complete supported nine-file application
recipe and the configured target's live ALB. Its only changes are deletion of
`ingress.yaml` and an exact `kustomization.yaml` update removing that resource.
The other seven manifests retain their bytes. The reviewer sees the target,
reason, Jev output, before hashes, replacement bytes, deleted path and exact
digest. A changed GitOps base or live target invalidates approval.

After the approved draft PR passes the trusted GitOps check and a human merges
it, an authorized Argo operator syncs the app revision **with pruning**. The
observer must see the merged PR, exact current GitOps files, Argo Synced and
Healthy at matching files, no Ingress in the dedicated namespace, and no
`rizz-staging-demo` ALB or target group tagged for this Ingress. Incomplete
AWS/Kubernetes inventories are unavailable, not proof of cleanup.

## Stage 2: remove application resources

The second preview is available only after the stage-one approved PR was
merged, its exact eight files still match the current GitOps tree, and the
Ingress/ALB/target-group absence check passes again. It replaces the
Kustomization with an empty resource list and deletes the other seven app
files. A new distinct platform approval is required; stage-one approval cannot
authorize the second deletion set.

After human merge, the Argo operator syncs the exact new revision with
pruning. The read-only observation requires the merged PR, exact one-file
retirement marker, matching Synced/Healthy Argo revision, and absence of the
app's Deployments, Services, ConfigMap, SecretStore, ExternalSecret,
ReplicaSets and Pods. It also rechecks Ingress, ALB and target groups and
rechecks Argo after the live reads. A page refresh never performs a sync or
deletion.

The empty Kustomization marker and Argo Application remain deliberately;
they do not recreate app resources. The initial bootstrap Application is not
owned by a parent GitOps Application. Removing that Application is a separate
platform cleanup decision after verifying no live resources remain. EKS/VPC,
namespace, ECR images, the AWS runtime secret, Terraform state and audit
history are retained. The Kubernetes observer does not read Secret values or
claim that retained resources have been destroyed. Follow the source
repository's retirement runbook before a separate foundation teardown.

## Required GitOps gate update

The trusted policy bundle in `infra/cloud-gitops` now recognizes only these
transition shapes: absent/present → present, present → ingress removed, and
ingress removed → empty marker. Rebuild and install that bundle through a
reviewed platform change before merging a retirement PR. The offline check
validates the manifest transition; it does not prove Agent Guard approval or
live ALB cleanup. Repository review and writer permissions remain separate
trust boundaries.

All code and manifests here are local preparation. No AWS retirement or
foundation destroy has been executed by this implementation work.
