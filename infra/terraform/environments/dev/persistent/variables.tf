variable "aws_region" {
  description = "Singapore region for persistent Cognito, S3 and optional CodeBuild."
  type        = string
  default     = "ap-southeast-1"
  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "Persistent regional resources must remain in ap-southeast-1."
  }
}

variable "project_name" {
  description = "Fixed project name for this account-bound dev persistent root."
  type        = string
  default     = "opsgrid"
  validation {
    condition     = var.project_name == "opsgrid"
    error_message = "This persistent root requires project_name=opsgrid to match its approved web and publisher targets."
  }
}

variable "environment" {
  description = "Fixed dev environment; other environments are outside this root's ownership."
  type        = string
  default     = "dev"
  validation {
    condition     = var.environment == "dev"
    error_message = "This persistent root requires environment=dev to match its approved web and publisher targets."
  }
}

variable "additional_tags" {
  description = "Additional tags; root ownership tags cannot be overridden."
  type        = map(string)
  default     = {}
}

variable "callback_urls" {
  description = "NestJS BFF OAuth callback URLs."
  type        = list(string)
  default     = ["http://localhost:3000/auth/callback"]
  validation {
    condition = length(var.callback_urls) > 0 && alltrue([
      for url in var.callback_urls : can(regex("^(https://[^[:space:]/?#]+([/?][^[:space:]#]*)?|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?][^[:space:]#]*)?)$", url))
    ])
    error_message = "callback_urls must contain absolute HTTPS URLs, or HTTP only for loopback hosts; whitespace/fragments are forbidden."
  }
}

variable "logout_urls" {
  description = "Post-logout redirect URLs."
  type        = list(string)
  default     = ["http://localhost:5173/login"]
  validation {
    condition = length(var.logout_urls) > 0 && alltrue([
      for url in var.logout_urls : can(regex("^(https://[^[:space:]/?#]+([/?][^[:space:]#]*)?|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?][^[:space:]#]*)?)$", url))
    ])
    error_message = "logout_urls must contain absolute HTTPS URLs, or HTTP only for loopback hosts; whitespace/fragments are forbidden."
  }
}

variable "create_user_pool_domain" {
  description = "Enable Cognito managed login and OAuth endpoints."
  type        = bool
  default     = false
}

variable "cognito_domain_prefix" {
  description = "Unique prefix required when Cognito managed login is enabled."
  type        = string
  default     = null
  validation {
    condition     = var.cognito_domain_prefix == null || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be null or a valid lowercase 1-63 character Cognito prefix."
  }
}

variable "enable_google_identity_provider" {
  description = "Enable the optional Google identity provider."
  type        = bool
  default     = false
}

variable "google_client_id" {
  description = "Optional Google OAuth client ID; preserve private deployment inputs."
  type        = string
  default     = null
  validation {
    condition     = var.google_client_id == null ? true : trimspace(var.google_client_id) != ""
    error_message = "google_client_id must be null or nonempty."
  }
}

variable "google_client_secret" {
  description = "Optional Google OAuth client secret; supply only in private ignored inputs."
  type        = string
  sensitive   = true
  default     = null
  validation {
    condition     = var.google_client_secret == null ? true : trimspace(var.google_client_secret) != ""
    error_message = "google_client_secret must be null or nonempty."
  }
}

variable "ingest_repository_name" {
  description = "Fixed ingest repository name, matching the guarded image publisher."
  type        = string
  default     = "opsgrid-ingest"
  validation {
    condition     = var.ingest_repository_name == "opsgrid-ingest"
    error_message = "This persistent root requires ingest_repository_name=opsgrid-ingest to match the approved publisher target."
  }
}

variable "api_repository_name" {
  description = "Distinct ECR Public repository name for the API image."
  type        = string
  default     = "opsgrid-api"
  validation {
    condition     = can(regex("^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$", var.api_repository_name)) && length(var.api_repository_name) >= 2 && length(var.api_repository_name) <= 256 && var.api_repository_name != var.ingest_repository_name
    error_message = "api_repository_name must be a valid 2-256 character lowercase ECR name, different from ingest_repository_name."
  }
}

variable "enable_codebuild_web" {
  description = "Explicitly opt into the repository's private PR build; disabled by default."
  type        = bool
  default     = false
}

variable "github_connection_arn" {
  description = "Existing AVAILABLE repository-authorized GitHub App connection in account 491333778094/Singapore; never a PAT."
  type        = string
  default     = null
  validation {
    condition     = var.github_connection_arn == null || can(regex("^arn:aws:(codeconnections|codestar-connections):ap-southeast-1:491333778094:connection/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.github_connection_arn))
    error_message = "github_connection_arn must be null or an account 491333778094 Singapore connection ARN."
  }
  validation {
    condition     = !var.enable_codebuild_web || var.github_connection_arn != null
    error_message = "enable_codebuild_web=true requires an existing approved github_connection_arn."
  }
}

variable "codebuild_build_timeout_minutes" {
  description = "Optional CodeBuild build timeout in whole minutes."
  type        = number
  default     = 20
  validation {
    condition     = var.codebuild_build_timeout_minutes >= 5 && var.codebuild_build_timeout_minutes <= 2160 && floor(var.codebuild_build_timeout_minutes) == var.codebuild_build_timeout_minutes
    error_message = "Build timeout must be a whole number from 5 to 2160 minutes."
  }
}

variable "codebuild_queued_timeout_minutes" {
  description = "Optional CodeBuild queue timeout in whole minutes."
  type        = number
  default     = 30
  validation {
    condition     = var.codebuild_queued_timeout_minutes >= 5 && var.codebuild_queued_timeout_minutes <= 480 && floor(var.codebuild_queued_timeout_minutes) == var.codebuild_queued_timeout_minutes
    error_message = "Queue timeout must be a whole number from 5 to 480 minutes."
  }
}
