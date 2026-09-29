mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test-operator" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-east-1:000000000000:repository/test-only" }
  }
}
variables {
  aws_profile                       = "test-only-profile"
  expected_account_id               = "000000000000"
  github_repository                 = "example-owner/Rizz.AI"
  github_oidc_subject               = "repo:example-owner/Rizz.AI:ref:refs/heads/master"
  existing_github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  budget_limit_usd                  = 5
  budget_email                      = "test-only@example.invalid"
}
run "publisher_boundary" {
  command = plan
  assert {
    condition     = alltrue([for repo in aws_ecr_repository.app : repo.image_tag_mutability == "IMMUTABLE" && !repo.force_delete && repo.image_scanning_configuration[0].scan_on_push])
    error_message = "Both repositories need immutable tags, scanning, and no forced deletion."
  }
  assert {
    condition     = length(aws_ecr_repository.app) == 2 && length(aws_iam_openid_connect_provider.github) == 0
    error_message = "Exactly two app repositories; reuse the existing shared OIDC provider."
  }
  assert {
    condition     = jsondecode(local.trust_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.github_oidc_subject && jsondecode(local.trust_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "Trust must match the exact branch subject and audience."
  }
  assert {
    condition     = alltrue([for a in flatten([for s in jsondecode(local.publisher_policy).Statement : s.Action]) : startswith(a, "ecr:") && !strcontains(a, "Delete") && !strcontains(a, "*")])
    error_message = "Publisher must not grant infrastructure, cluster or deletion permissions."
  }
  assert {
    condition     = length(jsondecode(local.publisher_policy).Statement[1].Resource) == 2 && jsondecode(local.publisher_policy).Statement[0].Action == ["ecr:GetAuthorizationToken"]
    error_message = "Only login may use Resource '*'; image operations need exact repo ARNs."
  }
  assert {
    condition     = alltrue([for p in aws_ecr_lifecycle_policy.untagged : jsondecode(p.policy).rules[0].selection.tagStatus == "untagged"])
    error_message = "Never auto-expire tagged approved/rollback releases."
  }
}
run "immutable_github_subject" {
  command = plan
  variables { github_oidc_subject = "repo:example-owner@123/Rizz.AI@456:ref:refs/heads/master" }
  assert {
    condition     = local.publisher_subject == var.github_oidc_subject
    error_message = "Do not strip immutable IDs out of the actual IAM trust subject."
  }
}
run "reject_wildcard_subject" {
  command = plan
  variables { github_oidc_subject = "repo:example-owner/Rizz.AI:*" }
  expect_failures = [var.github_oidc_subject]
}
run "reject_pull_request_subject" {
  command = plan
  variables { github_oidc_subject = "repo:example-owner/Rizz.AI:pull_request" }
  expect_failures = [var.github_oidc_subject]
}
run "require_oidc_preflight" {
  command = plan
  variables { existing_github_oidc_provider_arn = null }
  expect_failures = [var.existing_github_oidc_provider_arn]
}
run "reject_root" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:root" }
  }
  expect_failures = [terraform_data.account_guard]
}
run "dedicated_release_reader" {
  command = plan
  variables { release_reader_principal_arn = "arn:aws:iam::000000000000:user/test-operator" }
  assert {
    condition     = length(aws_iam_role.release_reader) == 1 && jsondecode(aws_iam_role.release_reader[0].assume_role_policy).Statement[0].Principal.AWS == var.release_reader_principal_arn
    error_message = "Reader trust must use the exact reviewed principal, not root/wildcard."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.release_reader[0].policy).Statement[0].Action == ["ecr:BatchGetImage"] && length(jsondecode(aws_iam_role_policy.release_reader[0].policy).Statement[0].Resource) == 2
    error_message = "Release reader needs only manifest reads on the two approved repositories."
  }
}
run "reject_root_reader_trust" {
  command = plan
  variables { release_reader_principal_arn = "arn:aws:iam::000000000000:root" }
  expect_failures = [var.release_reader_principal_arn]
}
