module "cognito" {
  source = "../../../../modules/cognito"

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
  additional_tags                 = var.additional_tags
}
