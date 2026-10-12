variable "region" {
  description = "AWS region for temporary compute; ECR Public remains in its persistent root."
  type        = string
  default     = "ap-southeast-1"
}

variable "allowed_account_id" {
  description = "Account allowed by the AWS provider."
  type        = string
  default     = "491333778094"
}

variable "api_name" {
  type    = string
  default = "opsgrid-dev-test-api"
}

variable "network_name" {
  description = "Name of the dedicated temporary VPC created by dev/test."
  type        = string
  default     = "opsgrid-dev-test"
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{1,26}[a-zA-Z0-9]$", var.network_name))
    error_message = "Use a 3-28 character alphanumeric/hyphen network name."
  }
}

variable "vpc_cidr" {
  description = "Private IPv4 VPC CIDR (/16 to /18); two public subnet CIDRs are derived with 8 additional prefix bits."
  type        = string
  default     = "10.42.0.0/16"
  validation {
    condition = can(cidrnetmask(var.vpc_cidr)) && can(cidrsubnet(var.vpc_cidr, 8, 1)) && try(
      tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 18,
      false
    ) && can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)", cidrhost(var.vpc_cidr, 0)))
    error_message = "Supply an RFC1918 IPv4 CIDR with prefix /16 to /18."
  }
}

variable "availability_zones" {
  description = "Exactly two distinct regional availability zones for the public ALBs and Fargate tasks."
  type        = list(string)
  default     = ["ap-southeast-1a", "ap-southeast-1b"]
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2 && alltrue([for az in var.availability_zones : can(regex("^${var.region}[a-z]$", az))])
    error_message = "Supply two distinct availability zones in the configured AWS region."
  }
}

variable "allowed_ingress_cidrs" {
  description = "ALB HTTP/HTTPS ingress; task ingress remains restricted to the ALB."
  type        = set(string)
}

variable "image_digest_uri" {
  description = "Immutable API image in the persistent ECR Public repository."
  type        = string
}

variable "certificate_arn" {
  description = "Existing issued ACM certificate in the ALB region."
  type        = string
}

variable "hosted_zone_id" {
  description = "Existing public Route53 hosted zone; API and ingest records are temporary."
  type        = string
}

variable "api_dns_name" {
  type = string
}

variable "parameter_path" {
  type    = string
  default = "/opsgrid/dev/test/api"
}

variable "database_port" {
  type = number
}

variable "redis_port" {
  type = number
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "runtime_secret_names" {
  description = "Nonsecret SSM parameter names; include COGNITO_CLIENT_SECRET only when used."
  type        = set(string)
  default = [
    "NODE_ENV", "PORT", "WEB_URL", "COGNITO_REGION", "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID", "DATABASE_URL", "REDIS_URL", "ENROLLMENT_TOKEN_CACHE_KEY"
  ]
}

variable "runtime_secret_values" {
  description = "Terraform auto-loads the git-ignored runtime.auto.tfvars.json for plan/apply/destroy. Keep this private file while managing the stack; write-only SSM values never enter plans/state."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  nullable    = false
}

variable "secret_value_version" {
  description = "Increment when changing a private runtime value: write-only values cannot be diffed."
  type        = number
  default     = 1
}
