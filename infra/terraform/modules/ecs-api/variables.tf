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

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = set(string)
  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "Supply at least two existing public subnets in different availability zones."
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
    condition     = length(setsubtract(var.runtime_secret_names, toset(["NODE_ENV", "PORT", "WEB_URL", "COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "DATABASE_URL", "REDIS_URL", "COGNITO_CLIENT_SECRET", "ENROLLMENT_TOKEN_CACHE_KEY"]))) == 0 && alltrue([for name in ["NODE_ENV", "PORT", "WEB_URL", "COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "DATABASE_URL", "REDIS_URL", "ENROLLMENT_TOKEN_CACHE_KEY"] : contains(var.runtime_secret_names, name)])
    error_message = "Supply all API runtime parameter names, with optional Cognito client secret only."
  }
}

variable "runtime_secret_values" {
  type      = map(string)
  sensitive = true
  ephemeral = true
}

variable "secret_value_version" {
  type    = number
  default = 1
  validation {
    condition     = var.secret_value_version >= 1 && floor(var.secret_value_version) == var.secret_value_version
    error_message = "Secret write-only version must be a positive integer."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
