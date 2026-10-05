output "project_name" {
  value = module.codebuild.name
}

output "project_arn" {
  value = module.codebuild.arn
}

output "service_role_arn" {
  value = module.build_role.arn
}

output "aws_region" {
  value = var.aws_region
}

output "buildspec_path" {
  value = local.buildspec_path
}

output "web_bucket_name" {
  value = local.bucket_name
}

output "distribution_id" {
  value = local.distribution_id
}

output "webhook_url" {
  description = "URL of the sole PR webhook."
  value       = module.codebuild.webhook_urls["pr"]
}

output "webhook_payload_url" {
  description = "CodeBuild endpoint receiving PR events; not the sensitive webhook secret."
  value       = module.codebuild.webhook_payload_urls["pr"]
}

output "pull_request_build_policy" {
  description = "Native policy supplied to the sole PR webhook; buildspec cannot override it."
  value       = local.approval_policy
}
