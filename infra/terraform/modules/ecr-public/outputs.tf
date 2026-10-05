output "repository_uri" {
  description = "Public image repository URI, without a tag or digest."
  value       = aws_ecrpublic_repository.this.repository_uri
}

output "repository_arn" {
  description = "ECR Public repository ARN."
  value       = aws_ecrpublic_repository.this.arn
}

output "repository_name" {
  description = "Long-lived public repository name."
  value       = aws_ecrpublic_repository.this.repository_name
}

output "registry_id" {
  description = "AWS account ID that owns the public registry, not its public alias."
  value       = aws_ecrpublic_repository.this.registry_id
}
