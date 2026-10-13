variable "name" {
  description = "Name prefix for this API deployment."
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{0,26}[a-zA-Z0-9]$", var.name))
    error_message = "Use a 2-28 character alphanumeric/hyphen name, allowing the ALB/task suffixes."
  }
}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "sns_alerts_enabled" {
  description = "Enable the verified SNS alert handler; independent from AMP querying."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.sns_alerts_enabled || var.sns_alerts_topic_arn != null
    error_message = "Enabled SNS alert handling requires an existing topic ARN."
  }
}

variable "sns_alerts_topic_arn" {
  description = "Existing Standard SNS topic; nonsecret, exact-region/account IAM and verifier scope."
  type        = string
  default     = null
  validation {
    condition     = var.sns_alerts_topic_arn == null || can(regex("^arn:aws:sns:${var.region}:${var.account_id}:[A-Za-z0-9_-]{1,256}$", var.sns_alerts_topic_arn))
    error_message = "SNS alerts require a Standard topic in this deployment's region/account."
  }
}

variable "vpc_id" {
  type = string
}

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
    error_message = "Supply valid IPv4 ingress CIDRs; 0.0.0.0/0 is permitted for a public API."
  }
}

variable "image_digest_uri" {
  type = string
  validation {
    condition     = can(regex("^public\\.ecr\\.aws/[^/]+/[^/]+@sha256:[a-f0-9]{64}$", var.image_digest_uri))
    error_message = "Use an immutable ECR Public image digest."
  }
}

variable "certificate_arn" {
  type = string
  validation {
    condition     = startswith(var.certificate_arn, "arn:aws:acm:${var.region}:${var.account_id}:certificate/")
    error_message = "Use an existing ACM certificate in the deployment region/account."
  }
}

variable "hosted_zone_id" {
  type = string
}

variable "dns_name" {
  type = string
}

variable "parameter_path" {
  type = string
  validation {
    condition     = startswith(var.parameter_path, "/") && !endswith(var.parameter_path, "/")
    error_message = "Use an absolute SSM parameter path without a trailing slash."
  }
}

variable "database_port" {
  type = number
  validation {
    condition     = var.database_port >= 1 && var.database_port <= 65535 && floor(var.database_port) == var.database_port
    error_message = "A valid PostgreSQL endpoint port is required."
  }
}

variable "redis_port" {
  type = number
  validation {
    condition     = var.redis_port >= 1 && var.redis_port <= 65535 && floor(var.redis_port) == var.redis_port
    error_message = "A valid Redis endpoint port is required."
  }
}

variable "cpu" {
  type    = number
  default = 256
  validation {
    condition     = var.cpu == 256
    error_message = "The temporary low-cost API uses Fargate CPU256."
  }
}

variable "memory" {
  type    = number
  default = 512
  validation {
    condition     = contains([512, 1024], var.memory)
    error_message = "Use 512 initially; use 1024 only after reviewing measured OOM evidence."
  }
}

variable "runtime_secret_names" {
  type = set(string)
  validation {
    condition     = length(setsubtract(var.runtime_secret_names, toset(["NODE_ENV", "PORT", "WEB_URL", "COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "DATABASE_URL", "REDIS_URL", "COGNITO_CLIENT_SECRET", "ENROLLMENT_TOKEN_CACHE_KEY", "METRICS_QUERY_URL", "METRICS_QUERY_AUTH_MODE", "METRICS_USERNAME", "METRICS_QUERY_TOKEN", "AGENT_API_PUBLIC_URL", "AGENT_METRICS_WRITE_URL", "AGENT_MONITORING_SECRET_KEY"]))) == 0 && alltrue([for name in ["NODE_ENV", "PORT", "WEB_URL", "COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "DATABASE_URL", "REDIS_URL", "ENROLLMENT_TOKEN_CACHE_KEY"] : contains(var.runtime_secret_names, name)])
    error_message = "Supply all API runtime parameter names, with optional Cognito client secret, metrics query and agent monitoring configuration."
  }
}

variable "runtime_secret_values" {
  type      = map(string)
  sensitive = true
  ephemeral = true
  nullable  = false
  validation {
    condition     = toset(keys(var.runtime_secret_values)) == var.runtime_secret_names && alltrue([for value in values(var.runtime_secret_values) : length(trimspace(value)) > 0 && length(base64encode(value)) * 3 / 4 - length(regexall("=", base64encode(value))) <= 4096])
    error_message = "Runtime keys must exactly match parameter names; nonempty values must fit SSM Standard size limits."
  }
  validation {
    condition     = var.amp_workspace_arn != null || length(setintersection(var.runtime_secret_names, toset(["METRICS_QUERY_URL", "METRICS_QUERY_AUTH_MODE", "METRICS_USERNAME", "METRICS_QUERY_TOKEN"]))) == 0 || (contains(var.runtime_secret_names, "METRICS_QUERY_URL") && contains(["none", "basic", "bearer"], (trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", ""))))) && can(regex("^(https://[^/@[:space:]?#]+|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?)(/[^[:space:]?#]*)?$", lookup(var.runtime_secret_values, "METRICS_QUERY_URL", ""))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")))) == "none" || (lookup(var.runtime_secret_values, "METRICS_QUERY_TOKEN", "") != "" && lookup(var.runtime_secret_values, "METRICS_QUERY_TOKEN", "") == trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_TOKEN", "")) && !can(regex("[[:cntrl:]]", lookup(var.runtime_secret_values, "METRICS_QUERY_TOKEN", ""))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")))) != "bearer" || can(regex("^[\\x21-\\x7e]+$", lookup(var.runtime_secret_values, "METRICS_QUERY_TOKEN", "")))))) && ((trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")) == "" ? "basic" : lower(trimspace(lookup(var.runtime_secret_values, "METRICS_QUERY_AUTH_MODE", "")))) != "basic" || (trimspace(lookup(var.runtime_secret_values, "METRICS_USERNAME", "")) != "" && !can(regex("[[:cntrl:]:]", lookup(var.runtime_secret_values, "METRICS_USERNAME", ""))))))
    error_message = "Metrics query configuration requires a safe HTTPS/loopback base URL and credentials for its selected none/basic/bearer mode."
  }
}

variable "secret_value_version" {
  type    = number
  default = 1
  validation {
    condition     = var.secret_value_version >= 1 && floor(var.secret_value_version) == var.secret_value_version
    error_message = "Secret write-only version must be a positive integer."
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
