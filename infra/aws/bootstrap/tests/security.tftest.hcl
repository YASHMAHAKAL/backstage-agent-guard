mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test-operator" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::rizz-platform-state-test-only" }
  }
}
variables {
  aws_profile         = "test-only-profile"
  expected_account_id = "000000000000"
  state_bucket_name   = "rizz-platform-state-test-only"
}
run "protected_state_storage" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.force_destroy == false && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State storage must retain data and support version recovery."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "State bucket must not be public."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "State encryption is required."
  }
  assert {
    condition     = jsondecode(aws_s3_bucket_policy.tls_only.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "Deny non-TLS state access."
  }
}
run "reject_root" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:root" }
  }
  expect_failures = [terraform_data.account_guard]
}
run "reject_wrong_account" {
  command = plan
  variables { expected_account_id = "111111111111" }
  expect_failures = [terraform_data.account_guard]
}
