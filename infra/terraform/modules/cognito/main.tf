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
