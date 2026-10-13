locals {
  common_tags = merge(
    var.additional_tags,
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Component   = "ecr-public"
    },
  )
}

resource "aws_ecrpublic_repository" "this" {
  repository_name = var.repository_name
  force_destroy   = var.force_destroy
  tags            = local.common_tags
}
