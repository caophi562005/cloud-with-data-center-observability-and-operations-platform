locals {
  common_tags = merge(
    var.additional_tags,
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Component   = "identity"
    },
  )

  explicit_auth_flows = concat(
    ["ALLOW_REFRESH_TOKEN_AUTH"],
    var.enable_user_password_auth ? ["ALLOW_USER_PASSWORD_AUTH"] : [],
  )
}

data "aws_region" "current" {}

resource "aws_cognito_user_pool" "this" {
  name                     = "${var.project_name}-${var.environment}"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "INACTIVE"
  mfa_configuration        = "OFF"

  username_configuration {
    case_sensitive = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Confirm your OpsGrid account"
    email_message        = "Your OpsGrid verification code is {####}."
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = "0"
      max_length = "2048"
    }
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = false
    mutable             = true
    string_attribute_constraints {
      min_length = "0"
      max_length = "2048"
    }
  }

  tags = local.common_tags

  lifecycle {
    precondition {
      condition     = length("${var.project_name}-${var.environment}") <= 128
      error_message = "The combined project_name-environment Cognito User Pool name must not exceed 128 characters."
    }
  }
}

resource "aws_cognito_user_pool_client" "this" {
  name                          = "${var.project_name}-${var.environment}-bff"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = var.generate_secret
  explicit_auth_flows           = local.explicit_auth_flows
  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"

  allowed_oauth_flows_user_pool_client = var.create_user_pool_domain
  allowed_oauth_flows                  = var.create_user_pool_domain ? ["code"] : []
  allowed_oauth_scopes                 = var.create_user_pool_domain ? ["openid", "email", "profile"] : []
  callback_urls                        = var.create_user_pool_domain ? var.callback_urls : []
  logout_urls                          = var.create_user_pool_domain ? var.logout_urls : []
  supported_identity_providers         = concat(["COGNITO"], var.enable_google_identity_provider ? ["Google"] : [])

  depends_on = [aws_cognito_identity_provider.google]
}

resource "aws_cognito_user_pool_domain" "this" {
  count                 = var.create_user_pool_domain ? 1 : 0
  domain                = var.cognito_domain_prefix
  managed_login_version = 2
  user_pool_id          = aws_cognito_user_pool.this.id

  lifecycle {
    precondition {
      condition     = var.cognito_domain_prefix == null ? false : length(trimspace(var.cognito_domain_prefix)) > 0
      error_message = "cognito_domain_prefix must be non-empty when create_user_pool_domain is true."
    }
  }
}

resource "aws_cognito_managed_login_branding" "this" {
  count                       = var.create_user_pool_domain ? 1 : 0
  client_id                   = aws_cognito_user_pool_client.this.id
  use_cognito_provided_values = true
  user_pool_id                = aws_cognito_user_pool.this.id

  depends_on = [aws_cognito_user_pool_domain.this]
}

resource "aws_cognito_identity_provider" "google" {
  count         = var.enable_google_identity_provider ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    authorize_scopes = "openid email profile"
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
  }

  attribute_mapping = {
    email = "email"
    name  = "name"
  }

  lifecycle {
    precondition {
      condition     = var.create_user_pool_domain
      error_message = "enable_google_identity_provider requires create_user_pool_domain to be true."
    }
    precondition {
      condition     = var.google_client_id == null ? false : length(trimspace(var.google_client_id)) > 0
      error_message = "google_client_id must be non-empty when Google is enabled."
    }
    precondition {
      condition     = var.google_client_secret == null ? false : length(trimspace(var.google_client_secret)) > 0
      error_message = "google_client_secret must be non-empty when Google is enabled."
    }
  }
}
