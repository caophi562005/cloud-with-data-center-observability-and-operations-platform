# Task-local signer only. No port mapping, public listener, AWS keys or SSM secrets.
# The image entrypoint is preserved; command contains flags only.
locals {
  container_definition = {
    essential              = true
    image                  = var.image_digest_uri
    cpu                    = 64
    memory                 = 128
    memoryReservation      = 64
    readonlyRootFilesystem = true
    user                   = "65532:65532"
    linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } }
    command = [
      "--name", "aps",
      "--region", var.region,
      "--host", "aps-workspaces.${var.region}.amazonaws.com",
      "--upstream-url-scheme", "https",
      "--port", "127.0.0.1:8005",
    ]
    environment                 = [{ name = "AWS_REGION", value = var.region }]
    secrets                     = []
    portMappings                = []
    mountPoints                 = []
    systemControls              = []
    volumesFrom                 = []
    startTimeout                = 30
    stopTimeout                 = 30
    create_cloudwatch_log_group = false
    enable_cloudwatch_logging   = true
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = var.log_group_name, awslogs-region = var.region, awslogs-stream-prefix = "amp-sigv4" }
    }
    # No invented /health route or curl/shell binary. START orders processes,
    # not listener readiness; essential exit and service circuit breaker govern failure.
  }
}

output "container_definition" {
  value = local.container_definition
}
