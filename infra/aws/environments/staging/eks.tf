resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = 3
  depends_on        = [terraform_data.account_guard]
}
resource "aws_eks_cluster" "staging" {
  name                      = local.cluster_name
  role_arn                  = aws_iam_role.cluster.arn
  version                   = "1.35"
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }
  upgrade_policy { support_type = "STANDARD" }
  vpc_config {
    subnet_ids              = [for subnet in aws_subnet.private : subnet.id]
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.operator_public_cidrs
  }
  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.control_plane]
  # EKS 1.28+ provides default envelope encryption for Kubernetes API data.
  # No customer KMS key or Auto Mode resources are silently added.
}
resource "aws_eks_access_entry" "operator" {
  cluster_name  = aws_eks_cluster.staging.name
  principal_arn = var.operator_principal_arn
  type          = "STANDARD"
}
resource "aws_eks_access_policy_association" "operator" {
  cluster_name  = aws_eks_cluster.staging.name
  principal_arn = aws_eks_access_entry.operator.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope { type = "cluster" }
  # Explicit bootstrap/operator authority only; never the app publishing role.
}
resource "aws_launch_template" "worker" {
  name_prefix = "rizz-eks-staging-"
  credit_specification { cpu_credits = "standard" }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  # No public-IP interface, SSH key, extra node SG or custom bootstrap scripts.
}
resource "aws_eks_node_group" "staging" {
  cluster_name    = aws_eks_cluster.staging.name
  node_group_name = "rizz-staging-worker"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = [for subnet in aws_subnet.private : subnet.id]
  version         = "1.35"
  ami_type        = "AL2023_x86_64_STANDARD"
  release_version = var.node_ami_release_version
  capacity_type   = "ON_DEMAND"
  instance_types  = ["t3.large"]
  scaling_config {
    desired_size = var.worker_desired_size
    min_size     = 1
    max_size     = 2
  }
  launch_template {
    id      = aws_launch_template.worker.id
    version = aws_launch_template.worker.latest_version
  }
  update_config { max_unavailable = 1 }
  depends_on = [aws_iam_role_policy_attachment.node, aws_route.egress, aws_route_table_association.private, aws_eks_addon.before_compute]
}
locals {
  before_compute_addons = {
    "vpc-cni"                = var.addon_versions.vpc_cni
    "kube-proxy"             = var.addon_versions.kube_proxy
    "eks-pod-identity-agent" = var.addon_versions.pod_identity_agent
  }
}
resource "aws_eks_addon" "before_compute" {
  for_each                    = local.before_compute_addons
  cluster_name                = aws_eks_cluster.staging.name
  addon_name                  = each.key
  addon_version               = each.value
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  dynamic "pod_identity_association" {
    for_each = each.key == "vpc-cni" ? [1] : []
    content {
      role_arn        = aws_iam_role.pod["cni"].arn
      service_account = "aws-node"
    }
  }
  depends_on = [aws_iam_role_policy_attachment.cni]
}
resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.staging.name
  addon_name                  = "coredns"
  addon_version               = var.addon_versions.coredns
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  depends_on                  = [aws_eks_node_group.staging]
}
