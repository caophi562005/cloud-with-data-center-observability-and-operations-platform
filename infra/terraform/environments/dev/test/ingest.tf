module "ingest" {
  source = "../../../modules/ecs-ingest"
  count  = var.enable_ingest ? 1 : 0

  name                       = var.ingest_name
  region                     = var.region
  account_id                 = var.allowed_account_id
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = local.public_subnet_ids
  allowed_ingress_cidrs      = var.allowed_ingress_cidrs
  image_digest_uri           = var.ingest_image_digest_uri
  certificate_arn            = var.ingest_certificate_arn
  hosted_zone_id             = var.hosted_zone_id
  dns_name                   = var.ingest_dns_name
  parameter_path             = var.ingest_parameter_path
  database_port              = var.ingest_database_port
  redis_port                 = var.ingest_redis_port
  runtime_secret_names       = var.ingest_runtime_secret_names
  runtime_secret_values      = var.ingest_runtime_secret_values
  secret_value_version       = var.ingest_secret_value_version
  amp_workspace_arn          = var.amp_workspace_arn
  amp_proxy_image_digest_uri = var.amp_proxy_image_digest_uri

  # Route validation and internet-facing ALB creation require the complete network.
  depends_on = [module.vpc]

  tags = {
    Project     = "opsgrid"
    Environment = "dev"
    ManagedBy   = "terraform"
    Component   = "ingest"
    Lifecycle   = "temporary-test"
  }
}

variable "enable_ingest" {
  description = "Opt in to NEW AWS ECS ingest resources. The manual Azure app remains unmanaged."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_ingest || var.ingest_image_digest_uri != null
    error_message = "Enabled ingest requires its immutable ECR Public image."
  }
}

variable "ingest_name" {
  type    = string
  default = "opsgrid-dev-test-ingest"
}
variable "ingest_dns_name" {
  type    = string
  default = "ingest.opsgrid.hacmieu.com"
}
variable "ingest_parameter_path" {
  type    = string
  default = "/opsgrid/dev/test/ingest"
}
variable "ingest_image_digest_uri" {
  description = "Ingest-only immutable ECR Public image; independent of the API image."
  type        = string
  default     = null
}
variable "ingest_certificate_arn" {
  description = "Supply the existing regional ACM certificate later. Null means HTTP setup only."
  type        = string
  default     = null
}
variable "ingest_database_port" {
  description = "Actual port from the ingest PostgreSQL URL, not inferred from API settings."
  type        = number
  default     = 5432
}
variable "ingest_redis_port" {
  description = "Actual port from the ingest Redis URL, not inferred from API settings."
  type        = number
  default     = 6379
}
variable "ingest_runtime_secret_names" {
  description = "Nonsecret names for Standard SecureString parameters; Gateway plus optional smoke query values."
  type        = set(string)
  default     = []
}
variable "ingest_runtime_secret_values" {
  description = "Private ingest-runtime.auto.tfvars.json inputs; ephemeral SSM write-only values never enter plans/state."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  nullable    = false
  default     = {}
}
variable "ingest_secret_value_version" {
  description = "Increment when changing runtime values to update SSM and deploy fresh ECS tasks."
  type        = number
  default     = 1
}

output "ingest_alb_dns_name" { value = try(module.ingest[0].alb_dns_name, null) }
output "ingest_cluster_name" { value = try(module.ingest[0].cluster_name, null) }
output "ingest_service_name" { value = try(module.ingest[0].service_name, null) }
output "ingest_dns_name" { value = try(module.ingest[0].dns_name, null) }
output "ingest_url" { value = try(module.ingest[0].url, null) }
output "ingest_health_url" { value = try(module.ingest[0].health_url, null) }
output "ingest_ready_url" { value = try(module.ingest[0].ready_url, null) }
output "ingest_remote_write_url" { value = try(module.ingest[0].remote_write_url, null) }
