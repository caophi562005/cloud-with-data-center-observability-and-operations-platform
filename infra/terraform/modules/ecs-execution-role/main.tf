# Shared ECS execution role; no managed policies, OIDC, or instance profile.
module "iam_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role"
  version = "6.8.2"

  name            = var.name
  use_name_prefix = false
  tags            = var.tags

  trust_policy_permissions = {
    EcsTasks = {
      actions = ["sts:AssumeRole"]
      principals = [{
        type        = "Service"
        identifiers = ["ecs-tasks.amazonaws.com"]
      }]
      condition = [
        { test = "StringEquals", variable = "aws:SourceAccount", values = [var.account_id] },
        { test = "ArnLike", variable = "aws:SourceArn", values = ["arn:aws:ecs:${var.region}:${var.account_id}:*"] },
      ]
    }
  }

  create_inline_policy = true
  inline_policy_permissions = {
    LogDelivery = {
      actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      resources = ["${var.log_group_arn}:*"]
    }
    RuntimeParameters = {
      actions   = ["ssm:GetParameters"]
      resources = sort(tolist(var.parameter_arns))
    }
  }
}
