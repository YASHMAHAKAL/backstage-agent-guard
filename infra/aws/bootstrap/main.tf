variable "aws_profile" {
  type    = string
  default = "rizz-platform"
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Supply the intended 12-digit account ID privately."
  }
}
variable "state_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^rizz-platform-state-[a-z0-9-]{6,35}$", var.state_bucket_name))
    error_message = "Use a unique rizz-platform-state- suffix of 6–35 lowercase letters/digits/hyphens."
  }
}

data "aws_caller_identity" "operator" {}
resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.operator.account_id == var.expected_account_id && !endswith(data.aws_caller_identity.operator.arn, ":root")
      error_message = "Refusing wrong-account or AWS root identity. Use the intended non-root profile."
    }
  }
}

resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket_name
  force_destroy = false
  depends_on    = [terraform_data.account_guard]
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_policy" "tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
output "state_bucket_name" { value = aws_s3_bucket.state.id }
