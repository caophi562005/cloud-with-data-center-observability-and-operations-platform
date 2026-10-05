terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.67.0, < 7.0.0"
    }
  }

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = ["491333778094"]
}

provider "aws" {
  alias               = "global"
  region              = "us-east-1"
  allowed_account_ids = ["491333778094"]
}

locals {
  tags = merge(var.additional_tags, {
    Project   = var.project_name
    Env       = var.environment
    Layer     = "persistent"
    Lifecycle = "persistent"
    ManagedBy = "terraform"
  })
}

module "cognito" {
  source = "../../../modules/cognito"

  project_name                    = var.project_name
  environment                     = var.environment
  callback_urls                   = var.callback_urls
  logout_urls                     = var.logout_urls
  generate_secret                 = true
  enable_user_password_auth       = true
  create_user_pool_domain         = var.create_user_pool_domain
  cognito_domain_prefix           = var.cognito_domain_prefix
  enable_google_identity_provider = var.enable_google_identity_provider
  google_client_id                = var.google_client_id
  google_client_secret            = var.google_client_secret
  additional_tags                 = local.tags
}

module "ecr_ingest" {
  source    = "../../../modules/ecr-public"
  providers = { aws = aws.global }

  project_name    = var.project_name
  environment     = var.environment
  repository_name = var.ingest_repository_name
  force_destroy   = true
  additional_tags = local.tags
}

module "ecr_api" {
  source    = "../../../modules/ecr-public"
  providers = { aws = aws.global }

  project_name    = var.project_name
  environment     = var.environment
  repository_name = var.api_repository_name
  force_destroy   = true
  additional_tags = local.tags
}

module "s3_opsgrid_web" {
  source = "../../../modules/s3-opsgrid-web"
  providers = {
    aws        = aws
    aws.global = aws.global
  }

  bucket_name = "${var.project_name}-${var.environment}-web-491333778094"
  site_name   = "${var.project_name}-${var.environment}-web"
  tags = merge(local.tags, {
    Component = "opsgrid-web"
    Name      = "${var.project_name}-${var.environment}-web"
  })
}

module "codebuild_web" {
  source = "../../../modules/codebuild-web"
  count  = var.enable_codebuild_web ? 1 : 0

  project_name                     = var.project_name
  environment                      = var.environment
  aws_region                       = var.aws_region
  github_connection_arn            = var.github_connection_arn
  web_bucket_name                  = module.s3_opsgrid_web.bucket_name
  web_distribution_id              = module.s3_opsgrid_web.distribution_id
  codebuild_build_timeout_minutes  = var.codebuild_build_timeout_minutes
  codebuild_queued_timeout_minutes = var.codebuild_queued_timeout_minutes
  additional_tags                  = local.tags
}
