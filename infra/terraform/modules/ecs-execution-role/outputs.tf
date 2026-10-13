output "arn" {
  description = "Execution role ARN, ordered after its inline policy is attached."
  value       = module.iam_role.arn
  depends_on  = [module.iam_role]
}

output "name" {
  value      = module.iam_role.name
  depends_on = [module.iam_role]
}
