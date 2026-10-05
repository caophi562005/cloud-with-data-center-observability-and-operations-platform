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

variable "vpc_id" {
  description = "Existing VPC; not created or destroyed by this root."
  type        = string
}

variable "subnet_ids" {
  description = "Existing public subnets in at least two availability zones."
  type        = set(string)
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
  description = "Existing public Route53 hosted zone; only the API record is temporary."
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
