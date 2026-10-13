variable "region" {
  type = string
}

variable "image_digest_uri" {
  description = "Verified linux/amd64 aws-sigv4-proxy registry manifest digest; never a mutable tag."
  type        = string
  nullable    = false
  # Upstream release v1.13: exact linux/amd64 registry manifest, not image ID.
  default = "public.ecr.aws/aws-observability/aws-sigv4-proxy@sha256:ea098a33cca8a66516e60a4edebb313a2046eaf44cf1d754447f816fa275535f"
  validation {
    condition     = can(regex("^public\\.ecr\\.aws/aws-observability/aws-sigv4-proxy@sha256:[a-f0-9]{64}$", var.image_digest_uri))
    error_message = "Use an immutable AWS observability SigV4 proxy image digest."
  }
}

variable "log_group_name" {
  type = string
}
