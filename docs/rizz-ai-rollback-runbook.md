# Rizz.AI staging rollback (governed GitOps)

This is an application recovery request, **not** a Terraform rollback, direct
`kubectl` change, Argo history restore, or automatic deployment. The EKS target
must already exist. The backend only accepts a previously recorded healthy
Rizz.AI *release deployment*: exact approved files merged, Argo synced them,
both workloads passed, and smoke verification succeeded. An eligible CI build
alone is insufficient.

1. In the Rizz.AI Control Center, inspect **Verified deployment history** and
   the current delivery observation. Record the incident, current merge/Argo
   revision and desired historical release. If observation is unavailable, do
   not describe the current deployment as healthy or assume a rollback worked.
2. Open **Governed deployments → Propose a rollback**. Select the exact
   previously verified release deployment and state the intended recovery and
   scope. Preview first. It reads the current pinned GitOps tree and retained
   release evidence without creating a proposal or changing the cluster.
3. Compare the before/after image pair, replicas and changed file paths. The
   expected change is only the paired image digests and, if needed, bounded
   replica counts (1–2). Ingress, routing, secret references, model and other
   manifests must remain compatible. Missing/expired evidence, changed recipe,
   protected configuration or no-op produces a refusal; do not bypass it with
   manual YAML edits under the old approval.
4. Submit the proposal. Jev provides advisory semantic alignment; deterministic
   scope and identity checks still decide whether it can proceed. A different
   eligible app or platform reviewer examines the exact digest, source evidence
   and file diff in Backstage. The requester cannot approve their own request.
5. Approval starts a private Scaffolder task that opens an exact-base **draft**
   GitOps PR. Inspect required checks and the final diff; repository reviewers
   make a separate merge decision. If the base or evidence changes, refresh
   and submit a new reviewed snapshot. Never merge a changed candidate under
   the old digest.
6. After merge, observe Argo source/revision, both workload images and rollout,
   and the routed smoke result. Only matching merged files, synced files,
   verified workloads and smoke count as recovered. A PR, task, Argo badge or
   CI build alone is not success. Record the result and any residual incident.

New demo CI artifacts have 30-day retention and the release list
shows only recent runs. Stored verified-deployment history does **not** extend
artifact/ECR availability. For an expired/deleted release, publish and verify a
new paired release or prepare a reviewed migration; never fabricate evidence.
If ingress/security/secret configuration differs, use a separate reviewed
change. If this is a foundation problem (EKS, ALB controller, IAM, state), stop
the app rollback and use the infrastructure incident/teardown process instead.

Refreshing delivery is a read plus an idempotent first-success history write;
there is no background observer yet. Rollback has been exercised with local
synthetic fixtures, not a live Rizz.AI EKS deployment. Never read or paste
Gemini/AWS/GitHub secrets into the proposal, Jev output or incident log.
