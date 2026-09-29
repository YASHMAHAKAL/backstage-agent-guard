# Controller policy provenance

`lbc-v3.5.0.upstream.json` is the unmodified reference policy from
[kubernetes-sigs/aws-load-balancer-controller v3.5.0](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.5.0/docs/install/iam_policy.json),
retrieved 2026-09-26. The source project publishes this under
[Apache License 2.0](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.5.0/LICENSE).
SHA-256: `16f232c9d9f79366fe949c4550ad517a202380058a9e48d45a4e215044a20a6a`.

Terraform derives an ALB-only staging policy: removes WAF/Shield/Cognito/legacy
server-certificate operations and NLB ARN patterns, narrows explicit resource
ARNs to account/region, restricts regional calls to us-east-1, adds exact cluster
tag values where upstream requires tag presence, and confines security-group
creation/rule edits to the staging VPC. Empty condition operators are removed.

Read/list APIs and some ELB create/listener/rule operations still use `*`;
this is not a proof of minimum permissions or full IAM isolation by cluster.
Live IAM authorization is untested. App/Ingress input validation and trusted
GitOps writers remain essential. A narrowly service-constrained
`iam:CreateServiceLinkedRole` permission remains; that role is an account-shared
dependency, not a staging Terraform-owned resource to delete on teardown.

The deployed controller, policy and chart pins must be upgraded/reviewed
together. Never substitute a floating upstream policy during apply.

This is the dedicated role's sole inline policy, not a customer-managed policy:
the narrowed rendered policy exceeds the managed-policy 6,144-character limit.
Tests enforce the role's aggregate inline-policy 10,240-character limit. Adding
another inline policy to this role requires reviewing the combined size.
See [official IAM policy-size limits](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html).
