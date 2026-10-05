output "user_pool_id" {
  value = module.cognito.user_pool_id
}

output "user_pool_arn" {
  value = module.cognito.user_pool_arn
}

output "user_pool_client_id" {
  value = module.cognito.user_pool_client_id
}

output "issuer_url" {
  value = module.cognito.issuer_url
}

output "cognito_domain" {
  value = module.cognito.cognito_domain
}

output "oauth_authorize_url" {
  value = module.cognito.oauth_authorize_url
}

output "oauth_token_endpoint" {
  value = module.cognito.oauth_token_endpoint
}

output "repository_uri" {
  description = "Compatibility output for the relocated ingest image publisher."
  value       = module.ecr_ingest.repository_uri
}

output "repository_arn" {
  value = module.ecr_ingest.repository_arn
}

output "api_repository_uri" {
  value = module.ecr_api.repository_uri
}

output "api_repository_arn" {
  value = module.ecr_api.repository_arn
}

output "bucket_name" {
  value = module.s3_opsgrid_web.bucket_name
}

output "bucket_arn" {
  value = module.s3_opsgrid_web.bucket_arn
}

output "aws_region" {
  value = var.aws_region
}

output "distribution_id" {
  value = module.s3_opsgrid_web.distribution_id
}

output "distribution_arn" {
  value = module.s3_opsgrid_web.distribution_arn
}

output "https_url" {
  value = module.s3_opsgrid_web.https_url
}

output "subscription_arn" {
  value = module.s3_opsgrid_web.subscription_arn
}

output "pricing_plan" {
  value = module.s3_opsgrid_web.pricing_plan
}

output "pricing_plan_status" {
  value = module.s3_opsgrid_web.pricing_plan_status
}

output "cloudfront_stack_name" {
  value = module.s3_opsgrid_web.cloudfront_stack_name
}

output "codebuild_project_name" {
  value = try(module.codebuild_web[0].project_name, null)
}

output "codebuild_project_arn" {
  value = try(module.codebuild_web[0].project_arn, null)
}

output "codebuild_service_role_arn" {
  value = try(module.codebuild_web[0].service_role_arn, null)
}

output "codebuild_webhook_url" {
  value = try(module.codebuild_web[0].webhook_url, null)
}

output "codebuild_webhook_payload_url" {
  value = try(module.codebuild_web[0].webhook_payload_url, null)
}

output "codebuild_pull_request_build_policy" {
  value = try(module.codebuild_web[0].pull_request_build_policy, null)
}
