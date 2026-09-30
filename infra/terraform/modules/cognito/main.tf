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
