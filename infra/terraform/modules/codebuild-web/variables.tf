variable "project_name" {
  description = "Project prefix for the private web PR build."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,24}$", var.project_name))
    error_message = "project_name must be a lowercase letter followed by at most 24 lowercase letters, digits or hyphens."
  }
}

variable "environment" {
  description = "Environment prefix for the private web PR build."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase letter followed by at most 15 lowercase letters, digits or hyphens."
  }
}

variable "aws_region" {
  description = "CodeBuild and its GitHub App connection stay in Singapore."
  type        = string
  default     = "ap-southeast-1"
  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "The persistent web build must use Singapore (ap-southeast-1)."
  }
}

variable "github_connection_arn" {
  description = "Existing AVAILABLE repository-authorized GitHub App connection in account 491333778094/Singapore; never a PAT."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^arn:aws:(codeconnections|codestar-connections):ap-southeast-1:491333778094:connection/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.github_connection_arn))
    error_message = "Supply an existing Singapore connection ARN from account 491333778094; never a token or another region/account."
  }
}

variable "web_bucket_name" {
  description = "Bucket name from the web module, not a historical deployment literal."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.web_bucket_name))
    error_message = "web_bucket_name must be a well-formed S3 bucket name."
  }
}

variable "web_distribution_id" {
  description = "Distribution ID from the web module; IAM is scoped to this exact ID."
  type        = string
  validation {
    condition     = can(regex("^E[A-Z0-9]{7,31}$", var.web_distribution_id))
    error_message = "web_distribution_id must be a well-formed CloudFront distribution ID."
  }
}

variable "codebuild_build_timeout_minutes" {
  description = "Build timeout in whole minutes."
  type        = number
  default     = 20
  validation {
    condition     = var.codebuild_build_timeout_minutes >= 5 && var.codebuild_build_timeout_minutes <= 2160 && floor(var.codebuild_build_timeout_minutes) == var.codebuild_build_timeout_minutes
    error_message = "Build timeout must be a whole number from 5 to 2160 minutes."
  }
}

variable "codebuild_queued_timeout_minutes" {
  description = "Queue timeout in whole minutes."
  type        = number
  default     = 30
  validation {
    condition     = var.codebuild_queued_timeout_minutes >= 5 && var.codebuild_queued_timeout_minutes <= 480 && floor(var.codebuild_queued_timeout_minutes) == var.codebuild_queued_timeout_minutes
    error_message = "Queue timeout must be a whole number from 5 to 480 minutes."
  }
}

variable "additional_tags" {
  description = "Additional tags; module ownership/security tags cannot be overridden."
  type        = map(string)
  default     = {}
}
