variable "release_reader_principal_arn" {
  description = "Optional reviewed non-root operator IAM principal allowed to assume the dedicated read-only catalog role. Null creates no role."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.release_reader_principal_arn == null ? true : can(regex("^arn:aws:iam::${var.expected_account_id}:(user|role)/[A-Za-z0-9_+=,.@/-]+$", var.release_reader_principal_arn))
    error_message = "Reader role trust must name one reviewed non-root IAM user/role in the intended account."
  }
}
resource "aws_iam_role" "release_reader" {
  count                = var.release_reader_principal_arn == null ? 0 : 1
  name                 = "rizz-staging-release-reader"
  max_session_duration = 3600
  assume_role_policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { AWS = var.release_reader_principal_arn } }] })
  depends_on           = [terraform_data.account_guard]
}
resource "aws_iam_role_policy" "release_reader" {
  count  = var.release_reader_principal_arn == null ? 0 : 1
  name   = "read-release-image-pair"
  role   = aws_iam_role.release_reader[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ecr:BatchGetImage"], Resource = [for repo in aws_ecr_repository.app : repo.arn] }] })
}
output "release_reader_role_arn" {
  value = var.release_reader_principal_arn == null ? null : aws_iam_role.release_reader[0].arn
}
