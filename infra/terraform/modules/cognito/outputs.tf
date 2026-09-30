locals {
  cognito_domain = var.create_user_pool_domain ? "https://${aws_cognito_user_pool_domain.this[0].domain}.auth.${data.aws_region.current.name}.amazoncognito.com" : null
  issuer_url     = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "user_pool_id" {
  description = "Cognito User Pool id for NestJS token verification."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito User Pool ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_client_id" {
  description = "Confidential Cognito App Client id for the NestJS BFF."
  value       = aws_cognito_user_pool_client.this.id
}

output "issuer_url" {
  description = "OIDC issuer URL for NestJS token verification."
  value       = local.issuer_url
}

output "cognito_domain" {
  description = "Managed-login domain URL, or null when disabled."
  value       = local.cognito_domain
}

output "oauth_authorize_url" {
  description = "OAuth authorization endpoint, or null when the domain is disabled."
  value       = local.cognito_domain == null ? null : "${local.cognito_domain}/oauth2/authorize"
}

output "oauth_token_endpoint" {
  description = "OAuth token endpoint, or null when the domain is disabled."
  value       = local.cognito_domain == null ? null : "${local.cognito_domain}/oauth2/token"
}
