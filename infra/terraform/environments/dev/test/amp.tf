# The workspace belongs to dev/persistent, never to this temporary state.
# After creating it, pass that root's amp_workspace_arn output here.
# Null preserves existing backend configuration; no synthetic workspace is deployed.
variable "amp_workspace_arn" {
  description = "Existing persistent AMP workspace ARN. Set to enable both per-task signers and override legacy metrics credentials."
  type        = string
  default     = null
  validation {
    condition     = var.amp_workspace_arn == null || can(regex("^arn:aws:aps:${var.region}:${var.allowed_account_id}:workspace/ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.amp_workspace_arn))
    error_message = "AMP workspace must belong to this deployment's region/account."
  }
}

variable "amp_proxy_image_digest_uri" {
  description = "Optional verified immutable SigV4 proxy image override; null uses the shared module's pinned linux/amd64 image."
  type        = string
  default     = null
}

output "amp_enabled" {
  value = var.amp_workspace_arn != null
}

output "amp_workspace_arn" {
  value = var.amp_workspace_arn
}
