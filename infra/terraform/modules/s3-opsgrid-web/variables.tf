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

variable "installer_redirect" {
  description = "Optional installer hostname and existing issued ACM certificate in us-east-1; the normal CloudFront hostname continues serving the SPA."
  type = object({
    hostname        = string
    certificate_arn = string
  })
  default = null

  validation {
    condition = var.installer_redirect == null ? true : (
      can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.installer_redirect.hostname)) &&
      length(var.installer_redirect.hostname) <= 253 &&
      can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]{36}$", var.installer_redirect.certificate_arn))
    )
    error_message = "Installer redirects require a lowercase hostname and an existing us-east-1 ACM certificate ARN."
  }
}

variable "frontend_hostname" {
  description = "Optional SPA alias covered by the existing installer certificate; does not change installer routing."
  type        = string
  default     = null

  validation {
    condition = var.frontend_hostname == null ? true : (
      length(var.frontend_hostname) <= 253 &&
      can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.frontend_hostname)) &&
      (var.installer_redirect == null ? false : var.frontend_hostname != var.installer_redirect.hostname)
    )
    error_message = "frontend_hostname requires a distinct lowercase hostname and an existing installer certificate covering both aliases."
  }
}

variable "tags" {
  description = "Non-secret resource tags."
  type        = map(string)
  default     = {}
}
