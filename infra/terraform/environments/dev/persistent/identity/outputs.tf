output "user_pool_id" {
  description = "Cognito User Pool id for NestJS."
  value       = module.cognito.user_pool_id
}

output "user_pool_arn" {
  description = "Cognito User Pool ARN."
  value       = module.cognito.user_pool_arn
}

output "user_pool_client_id" {
  description = "Confidential Cognito App Client id for NestJS."
  value       = module.cognito.user_pool_client_id
}

output "issuer_url" {
  description = "OIDC issuer URL for NestJS."
  value       = module.cognito.issuer_url
}

output "cognito_domain" {
  description = "Cognito managed-login domain URL, or null when disabled."
  value       = module.cognito.cognito_domain
}

output "oauth_authorize_url" {
  description = "OAuth authorization endpoint, or null when disabled."
  value       = module.cognito.oauth_authorize_url
}

output "oauth_token_endpoint" {
  description = "OAuth token endpoint, or null when disabled."
  value       = module.cognito.oauth_token_endpoint
}
