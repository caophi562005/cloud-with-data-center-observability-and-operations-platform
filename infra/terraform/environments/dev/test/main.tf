# Single root/state for temporary dev/test infrastructure.
# Run terraform init, plan, apply and destroy directly from this directory.
# terraform.tfvars: environment settings; runtime.auto.tfvars.json: private inputs.
# Persistent infrastructure is managed separately and is never owned by this root.
terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.41"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.allowed_account_id]
}

module "api" {
  source = "../../../modules/ecs-api"

  name                  = var.api_name
  region                = var.region
  account_id            = var.allowed_account_id
  vpc_id                = var.vpc_id
  subnet_ids            = var.subnet_ids
  allowed_ingress_cidrs = var.allowed_ingress_cidrs
  image_digest_uri      = var.image_digest_uri
  certificate_arn       = var.certificate_arn
  hosted_zone_id        = var.hosted_zone_id
  dns_name              = var.api_dns_name
  parameter_path        = var.parameter_path
  database_port         = var.database_port
  redis_port            = var.redis_port
  cpu                   = var.cpu
  memory                = var.memory
  runtime_secret_names  = var.runtime_secret_names
  runtime_secret_values = var.runtime_secret_values
  secret_value_version  = var.secret_value_version

  tags = {
    Project     = "opsgrid"
    Environment = "dev"
    ManagedBy   = "terraform"
    Component   = "api"
    Lifecycle   = "temporary-test"
  }
}
