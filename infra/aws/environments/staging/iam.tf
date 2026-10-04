resource "aws_iam_role" "cluster" {
  name               = "rizz-eks-staging-control-plane"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  depends_on         = [terraform_data.account_guard]
}
resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}
resource "aws_iam_role" "node" {
  name               = "rizz-eks-staging-worker"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  depends_on         = [terraform_data.account_guard]
}
resource "aws_iam_role_policy_attachment" "node" {
  for_each   = toset(["AmazonEKSWorkerNodePolicy", "AmazonEC2ContainerRegistryPullOnly"])
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}
# CNI and secret sync have their own pod identities, not node-role permissions.
locals {
  pod_identities = {
    cni     = { namespace = "kube-system", service_account = "aws-node" }
    secrets = { namespace = "external-secrets", service_account = "external-secrets" }
    ingress = { namespace = "kube-system", service_account = "aws-load-balancer-controller" }
  }
}
locals {
  # Versioned upstream policy, narrowed for this ALB-only staging recipe.
  # Regional describe calls remain wildcard; not a blanket least-privilege claim.
  lbc_upstream = jsondecode(file("${path.module}/policies/lbc-v3.5.0.upstream.json"))
  lbc_policy = {
    Version = local.lbc_upstream.Version
    Statement = concat([for statement in local.lbc_upstream.Statement : merge(statement, {
      Action   = [for action in statement.Action : action if !startswith(action, "waf") && !startswith(action, "shield:") && !startswith(action, "cognito-idp:") && action != "elasticloadbalancing:SetWebAcl" && !startswith(action, "iam:ListServer") && !startswith(action, "iam:GetServer")]
      Resource = [for arn in flatten([statement.Resource]) : replace(replace(arn, "arn:aws:ec2:*:*:", "arn:aws:ec2:us-east-1:${var.expected_account_id}:"), "arn:aws:elasticloadbalancing:*:*:", "arn:aws:elasticloadbalancing:us-east-1:${var.expected_account_id}:") if !strcontains(arn, "/net/")]
      Condition = merge(try(statement.Condition, {}), {
        StringEquals = merge(try(statement.Condition.StringEquals, {}),
          contains(statement.Action, "iam:CreateServiceLinkedRole") ? {} : { "aws:RequestedRegion" = "us-east-1" },
          try(statement.Condition.Null["aws:RequestTag/elbv2.k8s.aws/cluster"], "true") == "false" ? { "aws:RequestTag/elbv2.k8s.aws/cluster" = local.cluster_name } : {},
          try(statement.Condition.Null["aws:ResourceTag/elbv2.k8s.aws/cluster"], "true") == "false" ? { "aws:ResourceTag/elbv2.k8s.aws/cluster" = local.cluster_name } : {}
        )
        # Include backend node security groups in this VPC, not arbitrary VPCs.
        ArnEquals = merge(try(statement.Condition.ArnEquals, {}), contains(statement.Action, "ec2:AuthorizeSecurityGroupIngress") ? { "ec2:Vpc" = "arn:aws:ec2:us-east-1:${var.expected_account_id}:vpc/${aws_vpc.staging.id}" } : {})
      })
      }) if !contains(statement.Action, "ec2:CreateSecurityGroup")], [
      # CreateSecurityGroup authorizes both the new security group and its VPC.
      # ec2:Vpc is not present for the VPC resource, so split the grants instead
      # of applying that condition to both resources.
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateSecurityGroup"]
        Resource = ["arn:aws:ec2:us-east-1:${var.expected_account_id}:security-group/*"]
        Condition = { StringEquals = {
          "aws:RequestedRegion" = "us-east-1"
        } }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateSecurityGroup"]
        Resource = ["arn:aws:ec2:us-east-1:${var.expected_account_id}:vpc/${aws_vpc.staging.id}"]
        Condition = { StringEquals = {
          "aws:RequestedRegion"         = "us-east-1"
          "aws:ResourceTag/Project"     = "rizz-platform"
          "aws:ResourceTag/Environment" = "staging"
          "aws:ResourceTag/ManagedBy"   = "terraform"
        } }
      }
    ])
  }
}
resource "aws_iam_role_policy" "ingress" {
  name = "rizz-eks-staging-ingress"
  role = aws_iam_role.pod["ingress"].id
  policy = jsonencode(merge(local.lbc_policy, {
    Statement = [for statement in local.lbc_policy.Statement : merge(statement, {
      Condition = { for operator, conditions in statement.Condition : operator => conditions if length(conditions) > 0 }
    })]
  }))
  lifecycle {
    precondition {
      condition     = filesha256("${path.module}/policies/lbc-v3.5.0.upstream.json") == "16f232c9d9f79366fe949c4550ad517a202380058a9e48d45a4e215044a20a6a"
      error_message = "Upstream ALB policy changed: review source/version/checksum and local restrictions together."
    }
  }
}
resource "aws_eks_pod_identity_association" "ingress" {
  cluster_name    = aws_eks_cluster.staging.name
  namespace       = local.pod_identities.ingress.namespace
  service_account = local.pod_identities.ingress.service_account
  role_arn        = aws_iam_role.pod["ingress"].arn
  depends_on      = [aws_iam_role_policy.ingress]
}
resource "aws_iam_role" "pod" {
  for_each = local.pod_identities
  name     = "rizz-eks-staging-${each.key}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "pods.eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"],
    Condition = { StringEquals = {
      "aws:RequestTag/eks-cluster-arn"            = aws_eks_cluster.staging.arn
      "aws:RequestTag/kubernetes-namespace"       = each.value.namespace
      "aws:RequestTag/kubernetes-service-account" = each.value.service_account
    } }
  }] })
}
resource "aws_iam_role_policy_attachment" "cni" {
  role       = aws_iam_role.pod["cni"].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}
resource "aws_secretsmanager_secret" "runtime" {
  name                    = "rizz/staging/runtime"
  recovery_window_in_days = 7
  depends_on              = [terraform_data.account_guard]
  # No secret VERSION/value resource: keys/passwords must not enter TF state.
}
resource "aws_iam_role_policy" "secrets" {
  name = "read-one-runtime-secret"
  role = aws_iam_role.pod["secrets"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource = aws_secretsmanager_secret.runtime.arn
  }] })
}
resource "aws_eks_pod_identity_association" "secrets" {
  cluster_name    = aws_eks_cluster.staging.name
  namespace       = local.pod_identities.secrets.namespace
  service_account = local.pod_identities.secrets.service_account
  role_arn        = aws_iam_role.pod["secrets"].arn
  depends_on      = [aws_iam_role_policy.secrets]
}
