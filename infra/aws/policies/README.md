# Operator preflight policy — manual attachment only

`preflight-readonly.json.example` grants the metadata calls in `../scripts/preflight.mjs`. It is not attached, provisioning authorization, a Terraform plan-read policy, a complete cloud inventory policy or a creation/publishing policy. It adds permissions; it does not remove permissions from other attached policies.

Replace every `ACCOUNT_ID` with the intended 12-digit account from the private `.env.aws.local` and `STATE_BUCKET_NAME` with that file's full proposed bucket name. Do not commit a personalized copy. JSON syntax validation alone does not validate IAM semantics; review AWS console policy validation before attachment.

## Attach to the actual operator identity

1. In your own terminal run `aws sts get-caller-identity --profile rizz-platform --query Arn --output text`. Keep the result private. For an `iam::...:user/...` ARN use that IAM user, not the CLI profile name. For `sts::...:assumed-role/...` use the corresponding IAM role, not the source user or session name. If the profile uses IAM Identity Center, ask its administrator to update the applicable permission set instead of editing an AWS-reserved role.
2. Use an authorized administrator session in the intended account. Open IAM → Users (or Roles) → the operator identity → Permissions → Add permissions → Create inline policy → JSON. Do not change a role trust policy or attach this as a permissions boundary. Do not grant the operator permission to modify its own IAM access just to perform preflight.
3. Paste the example with both placeholders replaced, review the actions/resources and console validation, then name the policy `RizzPlatformPreflightReadOnly` and create it.
4. Tell Codex the policy is attached; no credentials, account ID or ARN need to be pasted into chat. The next check remains read-only. Static-key profiles normally need no new keys/login; renewable SSO/session credentials may need their normal refresh. Allow for IAM propagation.

## Scope and caveats

- ECR and EKS describe permissions cover only the fixed new and legacy names in `us-east-1`. This does not authorize adoption or mutation of legacy resources.
- IAM permissions cover only the publisher role and GitHub OIDC provider metadata; no list-all, policy updates or AssumeRole grants are added.
- `ec2:DescribeVpcs` does not support resource ARN scoping. Its `Resource: "*"` is necessary; region is restricted. The preflight filters project Name tags, but **that filter is not an IAM access boundary**: the identity can describe other VPC metadata in this region too.
- S3 `HeadBucket` uses `s3:ListBucket`. This also grants listing object keys in the one proposed bucket if it exists; it grants **no object-content reads**, including no Terraform state download. AWS has no separate HeadBucket-only IAM action. No ListAllMyBuckets permission is granted. A 404 remains inconclusive.
- The already-working STS caller-identity operation needs no additional grant here.
- No ECR login/push, S3 writes, secret-value reads, IAM mutation, Kubernetes access or infrastructure creation/deletion permissions are granted.
- SCPs, session policies, permissions boundaries and explicit denies can still block these requests. If checks remain denied, diagnose the applicable restriction; do not remove a boundary or attach AdministratorAccess as a workaround.

Remove this temporary inline policy when preflight access is no longer required, under the administrator's reviewed scope. Provisioning later needs its own separately reviewed permission scope.

Sources: [ECR actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecr.html), [EKS actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_eks.html), [EC2 actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html), [S3 HeadBucket permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html), [IAM inline policy procedure](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html).
