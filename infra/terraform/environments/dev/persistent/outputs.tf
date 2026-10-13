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

output "frontend_url" {
  description = "Approved frontend HTTPS alias; null while frontend hosting is disabled."
  value       = var.frontend_dns_name == null ? null : "https://${var.frontend_dns_name}"
}

output "installer_urls" {
  description = "HTTPS short URLs; each returns a fixed GitHub latest-release launcher redirect."
  value = {
    linux   = "https://${var.installer_dns_name}/linux"
    windows = "https://${var.installer_dns_name}/windows"
  }
}

output "installer_certificate_arn" {
  description = "Explicit existing us-east-1 ACM certificate used by this root; not created or destroyed here."
  value       = var.installer_certificate_arn
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

output "amp_workspace_id" {
  description = "Identifier of the persistent AMP workspace."
  value       = module.amp.workspace_id
}

output "amp_workspace_arn" {
  description = "Amazon Resource Name of the persistent AMP workspace."
  value       = module.amp.workspace_arn
}

output "amp_endpoint" {
  description = "Base Prometheus endpoint for the persistent AMP workspace."
  value       = module.amp.endpoint
}

output "amp_query_url" {
  description = "Base Prometheus query URL; clients append API paths and sign requests with AWS SigV4."
  value       = module.amp.query_url
}

output "amp_remote_write_url" {
  description = "Prometheus remote-write API URL; requests require AWS SigV4."
  value       = module.amp.remote_write_url
}

output "amp_alerts_sns_topic_arn" {
  description = "Standard SNS alert topic ARN; downstream subscription is deferred."
  value       = module.amp_alerting.sns_topic_arn
}

output "amp_alert_rule_namespace" {
  description = "Namespace containing the four VM health alert rules."
  value       = module.amp_alerting.rule_namespace_name
}

output "amp_alert_manager_workspace_id" {
  description = "Existing AMP workspace hosting the Managed Alertmanager definition."
  value       = module.amp_alerting.alert_manager_workspace_id
}
