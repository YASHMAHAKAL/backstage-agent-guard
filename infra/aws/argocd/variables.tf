variable "aws_profile" {
  description = "Explicit reviewed platform operator profile with staging EKS access."
  type        = string
  default     = "rizz-platform"
  validation {
    condition     = length(trimspace(var.aws_profile)) > 0 && var.aws_profile != "default"
    error_message = "Use a named reviewed AWS profile, never implicit/default credentials."
  }
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Supply the intended account privately."
  }
}
variable "argocd_chart_archive" {
  description = "Optional local archive path; contents must match the reviewed chart lockfile. Defaults to this root's ignored .terraform/charts cache."
  type        = string
  default     = null
  nullable    = true
}
