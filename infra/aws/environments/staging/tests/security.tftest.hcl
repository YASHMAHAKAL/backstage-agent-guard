mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test-operator" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test-only" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = { arn = "arn:aws:eks:us-east-1:000000000000:cluster/rizz-eks-staging" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:000000000000:secret:rizz/staging/runtime-test00" }
  }
  mock_resource "aws_subnet" {
    defaults = { id = "subnet-00000000000000000" }
  }
  mock_resource "aws_vpc" {
    defaults = { id = "vpc-00000000000000000" }
  }
}
variables {
  aws_profile            = "test-only-profile"
  expected_account_id    = "000000000000"
  operator_principal_arn = "arn:aws:iam::000000000000:user/test-operator"
  operator_public_cidrs  = ["203.0.113.10/32"]
  availability_zones     = ["us-east-1a", "us-east-1b"]
  # Fixtures test syntax/binding only; these are NOT verified AWS versions.
  node_ami_release_version = "1.35.0-20260101"
  addon_versions = {
    vpc_cni            = "v1.0.0-eksbuild.1"
    kube_proxy         = "v1.35.0-eksbuild.1"
    coredns            = "v1.0.0-eksbuild.1"
    pod_identity_agent = "v1.0.0-eksbuild.1"
  }
}
run "private_single_node_foundation" {
  command = plan
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2 && alltrue([for subnet in aws_subnet.private : !subnet.map_public_ip_on_launch])
    error_message = "Workers must use two private subnets, never public-IP subnets."
  }
  assert {
    condition     = aws_vpc_endpoint.s3.service_name == "com.amazonaws.us-east-1.s3" && aws_nat_gateway.staging.subnet_id == aws_subnet.public["0"].id
    error_message = "Use one staging NAT and a private-route S3 gateway endpoint."
  }
  assert {
    condition     = aws_eks_cluster.staging.version == "1.35" && aws_eks_cluster.staging.upgrade_policy[0].support_type == "STANDARD" && aws_eks_cluster.staging.vpc_config[0].endpoint_private_access && aws_eks_cluster.staging.vpc_config[0].public_access_cidrs == toset(var.operator_public_cidrs)
    error_message = "Keep standard-support EKS and restrict public API access to reviewed operator IPs."
  }
  assert {
    condition     = aws_eks_node_group.staging.scaling_config[0].desired_size == var.worker_desired_size && aws_eks_node_group.staging.scaling_config[0].min_size == 1 && aws_eks_node_group.staging.scaling_config[0].max_size == 2 && toset(aws_eks_node_group.staging.instance_types) == toset(["t3.large"]) && aws_eks_node_group.staging.release_version == var.node_ami_release_version
    error_message = "Keep bounded worker capacity and the reviewed AMI release."
  }
  assert {
    condition     = aws_launch_template.worker.metadata_options[0].http_tokens == "required" && aws_launch_template.worker.metadata_options[0].http_put_response_hop_limit == 1 && aws_launch_template.worker.credit_specification[0].cpu_credits == "standard" && aws_launch_template.worker.block_device_mappings[0].ebs[0].encrypted
    error_message = "Require IMDSv2, encrypted disk and no surplus CPU-credit billing."
  }
}
run "identity_and_secret_boundaries" {
  command = plan
  assert {
    condition     = aws_eks_cluster.staging.access_config[0].authentication_mode == "API" && !aws_eks_cluster.staging.access_config[0].bootstrap_cluster_creator_admin_permissions && aws_eks_access_entry.operator.principal_arn == var.operator_principal_arn
    error_message = "Cluster administrator must be explicit, not inherited by app CI."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.node) == 2 && !contains(keys(aws_iam_role_policy_attachment.node), "AmazonEKS_CNI_Policy")
    error_message = "CNI permissions must not be attached to every worker."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.secrets.policy).Statement[0].Resource == aws_secretsmanager_secret.runtime.arn && jsondecode(aws_iam_role_policy.secrets.policy).Statement[0].Action == ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"] && aws_secretsmanager_secret.runtime.recovery_window_in_days == 7
    error_message = "Secret sync must read only the protected runtime secret."
  }
  assert {
    condition     = jsondecode(aws_iam_role.pod["secrets"].assume_role_policy).Statement[0].Condition.StringEquals["aws:RequestTag/kubernetes-service-account"] == "external-secrets" && jsondecode(aws_iam_role.pod["secrets"].assume_role_policy).Statement[0].Condition.StringEquals["aws:RequestTag/eks-cluster-arn"] == aws_eks_cluster.staging.arn
    error_message = "Pod trust must bind namespace/service account/cluster, not any pod."
  }
  assert {
    condition     = length(aws_eks_addon.before_compute) == 3 && aws_eks_addon.coredns.addon_version == var.addon_versions.coredns && one(aws_eks_addon.before_compute["vpc-cni"].pod_identity_association).service_account == "aws-node"
    error_message = "Pin all four add-ons and associate CNI with its separate role."
  }
}
run "ingress_controller_boundary" {
  command = plan
  assert {
    condition     = jsondecode(aws_iam_role.pod["ingress"].assume_role_policy).Statement[0].Condition.StringEquals["aws:RequestTag/kubernetes-service-account"] == "aws-load-balancer-controller" && aws_eks_pod_identity_association.ingress.namespace == "kube-system"
    error_message = "Ingress must use its dedicated cluster/namespace/SA-scoped Pod Identity."
  }
  assert {
    condition     = alltrue([for action in flatten([for statement in local.lbc_policy.Statement : statement.Action]) : !startswith(action, "waf") && !startswith(action, "shield:") && !startswith(action, "cognito-idp:") && !startswith(action, "secretsmanager:") && !startswith(action, "eks:")])
    error_message = "ALB controller needs no WAF/Shield/Cognito, secret or cluster administration authority."
  }
  assert {
    condition     = alltrue([for statement in local.lbc_policy.Statement : contains(statement.Action, "iam:CreateServiceLinkedRole") || statement.Condition.StringEquals["aws:RequestedRegion"] == "us-east-1"])
    error_message = "Regional controller operations must stay in the reviewed region."
  }
  assert {
    condition     = alltrue([for statement in local.lbc_policy.Statement : try(statement.Condition.Null["aws:ResourceTag/elbv2.k8s.aws/cluster"], "true") != "false" || try(statement.Condition.StringEquals["aws:ResourceTag/elbv2.k8s.aws/cluster"], "") == local.cluster_name])
    error_message = "Tagged resources must match this exact cluster, not any controller tag."
  }
  assert {
    condition     = alltrue([for statement in local.lbc_policy.Statement : !contains(statement.Action, "ec2:AuthorizeSecurityGroupIngress") || statement.Condition.ArnEquals["ec2:Vpc"] == "arn:aws:ec2:us-east-1:000000000000:vpc/vpc-00000000000000000"])
    error_message = "Security-group rule changes must be limited to this VPC."
  }
  assert {
    condition = (
      length([for statement in local.lbc_policy.Statement : statement if contains(statement.Action, "ec2:CreateSecurityGroup")]) == 2 &&
      toset(flatten([for statement in local.lbc_policy.Statement : statement.Resource if contains(statement.Action, "ec2:CreateSecurityGroup")])) == toset([
        "arn:aws:ec2:us-east-1:000000000000:security-group/*",
        "arn:aws:ec2:us-east-1:000000000000:vpc/vpc-00000000000000000",
      ]) &&
      alltrue([for statement in local.lbc_policy.Statement : !contains(statement.Action, "ec2:CreateSecurityGroup") || try(statement.Condition.ArnEquals["ec2:Vpc"], null) == null]) &&
      anytrue([for statement in local.lbc_policy.Statement :
        contains(statement.Action, "ec2:CreateSecurityGroup") &&
        contains(statement.Resource, "arn:aws:ec2:us-east-1:000000000000:vpc/vpc-00000000000000000") &&
        try(statement.Condition.StringEquals["aws:ResourceTag/Project"], "") == "rizz-platform" &&
        try(statement.Condition.StringEquals["aws:ResourceTag/Environment"], "") == "staging" &&
        try(statement.Condition.StringEquals["aws:ResourceTag/ManagedBy"], "") == "terraform"
      ])
    )
    error_message = "Security-group creation must authorize both resource types, with the VPC bound to tagged staging."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.ingress.policy).Statement : alltrue([for conditions in statement.Condition : length(conditions) > 0]) && length(statement.Action) > 0 && length(statement.Resource) > 0])
    error_message = "Do not render empty IAM conditions, actions or resources."
  }
  assert {
    condition     = length(aws_iam_role_policy.ingress.policy) <= 10240
    error_message = "The sole inline controller policy must fit the IAM role aggregate 10,240-character limit."
  }
}
run "reject_world_open_api" {
  command = plan
  variables { operator_public_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.operator_public_cidrs]
}
run "cloud_reader_disabled_by_default" {
  command = plan
  variables { cloud_reader_enabled = false }
  assert {
    condition     = length(aws_iam_role.cloud_reader) == 0 && length(aws_iam_role_policy.cloud_reader) == 0 && length(aws_eks_access_entry.cloud_reader) == 0
    error_message = "Existing staging configuration must not silently acquire a reader identity."
  }
}
run "cloud_reader_boundaries" {
  command = plan
  variables { cloud_reader_enabled = true }
  assert {
    condition     = jsondecode(aws_iam_role.cloud_reader[0].assume_role_policy).Statement[0].Principal.AWS == var.operator_principal_arn && aws_iam_role.cloud_reader[0].max_session_duration == 3600
    error_message = "Only the explicit reviewed non-root operator may assume the short-session observer role."
  }
  assert {
    condition     = aws_eks_access_entry.cloud_reader[0].type == "STANDARD" && aws_eks_access_entry.cloud_reader[0].kubernetes_groups == toset(["rizz-cloud-observers"]) && aws_eks_access_entry.cloud_reader[0].cluster_name == aws_eks_cluster.staging.name
    error_message = "Map the observer to its RBAC group in the exact staging cluster."
  }
  assert {
    condition     = toset(flatten([for statement in jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement : statement.Action])) == toset(["eks:DescribeCluster", "acm:DescribeCertificate", "acm:GetCertificate", "ssm:GetParameter", "ec2:DescribeSecurityGroups", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeListenerCertificates", "elasticloadbalancing:DescribeTags", "ecr:BatchGetImage"])
    error_message = "The observer must have only the exact implemented metadata/manifest reads, never IAM, secret-value, deploy or mutation permissions."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[0].Resource == [aws_eks_cluster.staging.arn] && jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[1].Condition.StringEquals["aws:ResourceTag/Project"] == "rizz-platform" && jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[1].Condition.StringEquals["aws:ResourceTag/Environment"] == "staging" && jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[2].Resource == ["arn:aws:ssm:us-east-1:000000000000:parameter/rizz/staging/https-target"] && jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[3].Condition.StringEquals["aws:RequestedRegion"] == "us-east-1"
    error_message = "Bind cluster reads, tagged staging certificate reads and regional metadata reads."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.cloud_reader[0].policy).Statement[4].Resource) == toset(["arn:aws:ecr:us-east-1:000000000000:repository/rizz-staging-frontend", "arn:aws:ecr:us-east-1:000000000000:repository/rizz-staging-backend"])
    error_message = "ECR manifest access must cover only the reviewed image pair."
  }
}
run "reject_subnet_operator_access" {
  command = plan
  variables { operator_public_cidrs = ["203.0.113.0/24"] }
  expect_failures = [var.operator_public_cidrs]
}
run "reject_root_principal" {
  command = plan
  variables { operator_principal_arn = "arn:aws:iam::000000000000:root" }
  expect_failures = [var.operator_principal_arn]
}
run "reject_root_caller" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:root" }
  }
  expect_failures = [terraform_data.account_guard]
}
run "reject_wrong_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "111111111111", arn = "arn:aws:iam::111111111111:user/operator" }
  }
  expect_failures = [terraform_data.account_guard]
}
run "reject_duplicate_zones" {
  command = plan
  variables { availability_zones = ["us-east-1a", "us-east-1a"] }
  expect_failures = [var.availability_zones]
}
run "reject_moving_addon" {
  command = plan
  variables {
    addon_versions = { vpc_cni = "latest", kube_proxy = "v1.35.0-eksbuild.1", coredns = "v1.0.0-eksbuild.1", pod_identity_agent = "v1.0.0-eksbuild.1" }
  }
  expect_failures = [var.addon_versions]
}
run "reject_unpinned_ami" {
  command = plan
  variables { node_ami_release_version = "latest" }
  expect_failures = [var.node_ami_release_version]
}
