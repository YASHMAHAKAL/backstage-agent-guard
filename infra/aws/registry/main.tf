data "aws_caller_identity" "operator" {}
resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.operator.account_id == var.expected_account_id && !endswith(data.aws_caller_identity.operator.arn, ":root")
      error_message = "Refusing wrong-account or AWS root identity."
    }
  }
}

resource "aws_ecr_repository" "app" {
  for_each             = toset(["frontend", "backend"])
  name                 = "rizz-staging-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration { encryption_type = "AES256" }
  image_scanning_configuration { scan_on_push = true }
  depends_on = [terraform_data.account_guard]
}
# Keep ALL tagged release images for explicit reviewed rollback/teardown.
# This is not an automatic 'keep last N' policy that could delete approvals.
resource "aws_ecr_lifecycle_policy" "untagged" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({ rules = [{ rulePriority = 1, description = "Expire untagged build remnants after seven days",
    selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }, action = { type = "expire" }
  }] })
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  depends_on     = [terraform_data.account_guard]
  # Shared account identity must not be removed during an application teardown.
  lifecycle { prevent_destroy = true }
}
locals {
  oidc_arn          = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_github_oidc_provider_arn
  publisher_subject = var.github_oidc_subject
  trust_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity", Principal = { Federated = local.oidc_arn },
    Condition = { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = local.publisher_subject } }
  }] })
  publisher_policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "RegistryLogin", Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Sid = "PublishOnlyTheImagePair", Effect = "Allow", Action = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
      "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:DescribeImageScanFindings"
    ], Resource = [for repo in aws_ecr_repository.app : repo.arn] }
  ] })
}
resource "aws_iam_role" "publisher" {
  name                 = "rizz-staging-image-publisher"
  assume_role_policy   = local.trust_policy
  max_session_duration = 3600
  depends_on           = [terraform_data.account_guard]
}
resource "aws_iam_role_policy" "publisher" {
  name   = "publish-rizz-image-pair"
  role   = aws_iam_role.publisher.id
  policy = local.publisher_policy
}
resource "aws_budgets_budget" "demo" {
  name         = "rizz-platform-demo-alert"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  # Account-wide to avoid missing untagged controller-owned spend. Alerts,
  # not automatic teardown or a hard cap; other account use also counts.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
  depends_on = [terraform_data.account_guard]
}
output "repository_urls" { value = { for component, repo in aws_ecr_repository.app : component => repo.repository_url } }
output "publisher_role_arn" { value = aws_iam_role.publisher.arn }
output "publisher_subject" { value = local.publisher_subject }
