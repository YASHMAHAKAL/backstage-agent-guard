variable "cloud_reader_enabled" {
  description = "Create the reviewed, read-only Backstage cloud observer role and EKS group mapping. Does not install Kubernetes RBAC or grant EKS access policies."
  type        = bool
  default     = false
}

resource "aws_iam_role" "cloud_reader" {
  count                = var.cloud_reader_enabled ? 1 : 0
  name                 = "rizz-staging-cloud-reader"
  max_session_duration = 3600
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { AWS = var.operator_principal_arn }
  }] })
  depends_on = [terraform_data.account_guard]
}

resource "aws_iam_role_policy" "cloud_reader" {
  count = var.cloud_reader_enabled ? 1 : 0
  name  = "read-rizz-cloud-delivery"
  role  = aws_iam_role.cloud_reader[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Effect = "Allow", Action = ["eks:DescribeCluster"], Resource = [aws_eks_cluster.staging.arn]
    },
    {
      Effect    = "Allow", Action = ["acm:DescribeCertificate", "acm:GetCertificate"],
      Resource  = ["arn:aws:acm:us-east-1:${var.expected_account_id}:certificate/*"],
      Condition = { StringEquals = { "aws:ResourceTag/Project" = "rizz-platform", "aws:ResourceTag/Environment" = "staging" } }
    },
    {
      # These describe APIs require wildcard resource access. Regional metadata
      # reads are broader than the app; there is no mutation authority.
      Effect = "Allow", Resource = ["*"],
      Action = [
        "ec2:DescribeSecurityGroups",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeListenerCertificates",
        "elasticloadbalancing:DescribeTags"
      ],
      Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } }
    },
    {
      Effect   = "Allow", Action = ["ecr:BatchGetImage"],
      Resource = [for name in ["rizz-staging-frontend", "rizz-staging-backend"] : "arn:aws:ecr:us-east-1:${var.expected_account_id}:repository/${name}"]
    }
  ] })
}

resource "aws_eks_access_entry" "cloud_reader" {
  count             = var.cloud_reader_enabled ? 1 : 0
  cluster_name      = aws_eks_cluster.staging.name
  principal_arn     = aws_iam_role.cloud_reader[0].arn
  type              = "STANDARD"
  kubernetes_groups = ["rizz-cloud-observers"]
  # No EKS access-policy association. Namespace-only operator-installed RBAC
  # supplies Kubernetes permissions; the role cannot read Kubernetes Secrets.
}

output "cloud_reader_role_arn" {
  value = var.cloud_reader_enabled ? aws_iam_role.cloud_reader[0].arn : null
}
