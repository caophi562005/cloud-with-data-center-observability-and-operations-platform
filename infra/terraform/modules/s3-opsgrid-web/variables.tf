variable "bucket_name" {
  description = "Globally unique private S3 bucket name for built OpsGrid web assets."
  type        = string

  validation {
    condition     = length(var.bucket_name) >= 3 && length(var.bucket_name) <= 63 && can(regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$", var.bucket_name))
    error_message = "Use a 3-63 character lowercase DNS-safe name without dots."
  }
}

variable "site_name" {
  description = "Stable project/environment name for CloudFront, WAF and the subscription stack."
  type        = string

  validation {
    condition     = length(var.site_name) >= 3 && length(var.site_name) <= 48 && can(regex("^[a-z][a-z0-9-]+[a-z0-9]$", var.site_name))
    error_message = "Use a 3-48 character lowercase name beginning with a letter."
  }
}

variable "tags" {
  description = "Non-secret resource tags."
  type        = map(string)
  default     = {}
}
