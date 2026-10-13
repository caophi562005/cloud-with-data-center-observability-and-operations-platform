variable "name" {
  type = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{0,26}[a-zA-Z0-9]$", var.name))
    error_message = "Use a 2-28 character alphanumeric/hyphen name for the ALB and task."
  }
}

variable "region" { type = string }
variable "account_id" { type = string }
variable "vpc_id" { type = string }
variable "hosted_zone_id" { type = string }
variable "dns_name" { type = string }

variable "subnet_ids" {
  description = "Ordered public subnet IDs; list indices stay known while a new VPC is being planned."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "Supply at least two public subnets in different availability zones."
  }
}

variable "allowed_ingress_cidrs" {
  type = set(string)
  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && alltrue([for cidr in var.allowed_ingress_cidrs : can(cidrnetmask(cidr))])
    error_message = "Supply valid IPv4 ALB ingress CIDRs."
  }
}

variable "image_digest_uri" {
  type = string
  validation {
    condition     = can(regex("^public\\.ecr\\.aws/[a-z0-9]+/opsgrid-ingest@sha256:[a-f0-9]{64}$", var.image_digest_uri))
    error_message = "Use the immutable ECR Public ingest image, not the API image or a mutable tag."
  }
}

variable "certificate_arn" {
  description = "Optional existing ACM certificate in this region/account. Null means HTTP only; never send agent credentials until HTTPS is configured."
  type        = string
  default     = null
  validation {
    condition     = var.certificate_arn == null || try(startswith(var.certificate_arn, "arn:aws:acm:${var.region}:${var.account_id}:certificate/"), false)
    error_message = "Use an existing ACM certificate in the deployment region/account, or null."
  }
}

variable "parameter_path" {
  type = string
  validation {
    condition     = can(regex("^/[a-zA-Z0-9_./-]+$", var.parameter_path)) && !endswith(var.parameter_path, "/")
    error_message = "Use an absolute SSM parameter path without a trailing slash."
  }
}

variable "database_port" {
  type = number
  validation {
    condition     = var.database_port >= 1 && var.database_port <= 65535 && floor(var.database_port) == var.database_port
    error_message = "Supply the PostgreSQL endpoint port."
  }
}

variable "redis_port" {
  type = number
  validation {
    condition     = var.redis_port >= 1 && var.redis_port <= 65535 && floor(var.redis_port) == var.redis_port
    error_message = "Supply the Redis endpoint port."
  }
}

variable "cpu" {
  type    = number
  default = 256
  validation {
    condition     = var.cpu == 256
    error_message = "Temporary ingest uses Fargate CPU256."
  }
}

variable "memory" {
  type    = number
  default = 512
  validation {
    condition     = contains([512, 1024], var.memory)
    error_message = "Use 512 initially, or 1024 after reviewing memory requirements."
  }
}

variable "runtime_secret_names" {
  description = "Nonsecret parameter names. Store optional smoke query inputs too, but never inject query credentials into the Gateway task."
  type        = set(string)
  validation {
    condition = length(setsubtract(var.runtime_secret_names, toset([
      "PORT", "LOG_LEVEL", "DATABASE_URL", "REDIS_URL", "AGENT_AUTH_CACHE_TTL_SECONDS",
      "METRICS_WRITE_URL", "METRICS_USERNAME", "METRICS_WRITE_TOKEN", "REMOTE_WRITE_TIMEOUT_SECONDS",
      "REMOTE_WRITE_MAX_BODY_BYTES", "RATE_LIMIT_REQUESTS_PER_SECOND", "RATE_LIMIT_BURST",
      "METRICS_QUERY_URL", "METRICS_QUERY_TOKEN", "METRICS_QUERY_AUTH_MODE", "METRICS_WRITE_AUTH_MODE"
    ]))) == 0 && alltrue([for name in ["PORT", "DATABASE_URL", "REDIS_URL"] : contains(var.runtime_secret_names, name)]) && (var.amp_workspace_arn != null || contains(var.runtime_secret_names, "METRICS_WRITE_URL"))
    error_message = "Supply Gateway runtime names, a write URL unless AMP is configured, and only supported optional query inputs."
  }
}

variable "runtime_secret_values" {
  description = "Private dotenv values; ephemeral and written only to SSM value_wo, never plans/state."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  nullable    = false
  validation {
    condition     = toset(keys(var.runtime_secret_values)) == var.runtime_secret_names && alltrue([for value in values(var.runtime_secret_values) : length(trimspace(value)) > 0 && length(base64encode(value)) * 3 / 4 - length(regexall("=", base64encode(value))) <= 4096])
    error_message = "Runtime keys must exactly match parameter names; nonempty values must fit SSM Standard size limits."
  }
  validation {
    condition     = lookup(var.runtime_secret_values, "PORT", "") == "8080"
    error_message = "PORT must match the ALB target: 8080."
  }
  validation {
    condition     = can(regex("^postgres(ql)?://", lookup(var.runtime_secret_values, "DATABASE_URL", ""))) && can(regex("^rediss?://", lookup(var.runtime_secret_values, "REDIS_URL", "")))
    error_message = "Use PostgreSQL and Redis URLs."
  }
  validation {
    condition     = var.amp_workspace_arn != null || (contains(["none", "basic", "bearer"], (trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", ""))))) && can(regex("^(https://[^/@[:space:]?#]+|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?)(/[^[:space:]?#]*)?$", lookup(var.runtime_secret_values, "METRICS_WRITE_URL", ""))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")))) == "none" || (lookup(var.runtime_secret_values, "METRICS_WRITE_TOKEN", "") != "" && lookup(var.runtime_secret_values, "METRICS_WRITE_TOKEN", "") == trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_TOKEN", "")) && !can(regex("[[:cntrl:]]", lookup(var.runtime_secret_values, "METRICS_WRITE_TOKEN", ""))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")))) != "bearer" || can(regex("^[\\x21-\\x7e]+$", lookup(var.runtime_secret_values, "METRICS_WRITE_TOKEN", "")))))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_WRITE_AUTH_MODE", "")))) != "basic" || (trimspace(lookup(var.runtime_secret_values, "METRICS_USERNAME", "")) != "" && !can(regex("[[:cntrl:]:]", lookup(var.runtime_secret_values, "METRICS_USERNAME", ""))))))
    error_message = "Metrics write configuration requires a safe HTTPS/loopback URL and credentials for its selected none/basic/bearer mode."
  }
}

variable "secret_value_version" {
  description = "Increment on runtime changes; updates SSM write-only values and rolls the ECS task definition."
  type        = number
  default     = 1
  validation {
    condition     = var.secret_value_version >= 1 && floor(var.secret_value_version) == var.secret_value_version
    error_message = "Use a positive integer runtime version."
  }
}

variable "amp_workspace_arn" {
  description = "Persistent AMP workspace; null keeps the portable direct backend."
  type        = string
  default     = null
  validation {
    condition     = var.amp_workspace_arn == null || can(regex("^arn:aws:aps:${var.region}:${var.account_id}:workspace/ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.amp_workspace_arn))
    error_message = "AMP workspace must match the task region/account."
  }
}

variable "amp_proxy_image_digest_uri" {
  type    = string
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
