# DEV/TEST only: native Basic Auth protects the UI/API over ACA public HTTPS.
# Grafana forwarding and real notification receivers remain Step 2 work.
data "azurerm_resource_group" "alertmanager" {
  name = var.alertmanager_resource_group_name
}

locals {
  # The web config contains a bcrypt verifier, never the plaintext password.
  alertmanager_web_config = yamlencode({
    basic_auth_users = {
      (var.alertmanager_basic_auth_username) = var.alertmanager_basic_auth_password_hash
    }
  })

  alertmanager_tags = {
    Project     = "opsgrid"
    Environment = "dev"
    ManagedBy   = "terraform"
    Component   = "alertmanager"
    Lifecycle   = "temporary-test"
  }
}

# Explicit Standard mode is required: Express rejects native Secret volumes.
# A sole Consumption profile does not provision Dedicated capacity.
# No custom subnet or Log Analytics workspace; retained logs are disabled.
resource "azapi_resource" "alertmanager_environment" {
  type      = "Microsoft.App/managedEnvironments@2026-07-01"
  name      = var.alertmanager_environment_name
  location  = data.azurerm_resource_group.alertmanager.location
  parent_id = data.azurerm_resource_group.alertmanager.id

  # This stable API is newer than AzAPI 2.13.0's embedded schemas.
  # Azure validates the request; the postcondition verifies actual mode.
  schema_validation_enabled = false
  response_export_values    = ["properties.environmentMode"]

  body = {
    properties = {
      environmentMode     = "WorkloadProfiles"
      publicNetworkAccess = "Enabled"
      zoneRedundant       = false
      workloadProfiles = [
        {
          name                = "Consumption"
          workloadProfileType = "Consumption"
        }
      ]
    }
  }

  lifecycle {
    postcondition {
      condition     = self.output.properties.environmentMode == "WorkloadProfiles"
      error_message = "Alertmanager requires Standard WorkloadProfiles mode; Express does not support Secret volumes."
    }
  }

  tags = local.alertmanager_tags
}

resource "azurerm_container_app" "alertmanager" {
  name                         = var.alertmanager_container_app_name
  resource_group_name          = data.azurerm_resource_group.alertmanager.name
  container_app_environment_id = azapi_resource.alertmanager_environment.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"

  # Non-credential YAML. App-secret values still enter Terraform state.
  secret {
    name  = "alertmanager-config"
    value = file("${path.module}/alertmanager.yml")
  }

  secret {
    name  = "alertmanager-web-config"
    value = local.alertmanager_web_config
  }

  template {
    min_replicas = 1
    max_replicas = 1

    # With no per-secret mapping, the native volume mounts all app secrets.
    # Filenames equal secret names; storage_name is not a secret selector.
    volume {
      name         = "alertmanager-config"
      storage_type = "Secret"
    }

    container {
      name   = "alertmanager"
      image  = "prom/alertmanager:v0.34.1"
      cpu    = 0.25
      memory = "0.5Gi"

      # Preserve the official /bin/alertmanager entrypoint; no shell bootstrap.
      # /tmp state is disposable; peer clustering/port 9094 is disabled.
      args = [
        "--config.file=/etc/alertmanager-runtime/alertmanager-config",
        "--web.config.file=/etc/alertmanager-runtime/alertmanager-web-config",
        "--storage.path=/tmp/alertmanager",
        "--web.listen-address=:9093",
        "--cluster.listen-address=",
      ]

      # App-secret updates alone do not roll revisions or reload the process.
      env {
        name  = "ALERTMANAGER_CONFIG_SHA256"
        value = filesha256("${path.module}/alertmanager.yml")
      }

      env {
        name = "ALERTMANAGER_WEB_CONFIG_SHA256"
        # Only the one-way config digest is exposed as a revision marker.
        # The bcrypt verifier itself remains in the sensitive app secret.
        value = nonsensitive(sha256(local.alertmanager_web_config))
      }

      volume_mounts {
        name = "alertmanager-config"
        path = "/etc/alertmanager-runtime"
      }

      # Basic Auth also protects HTTP health endpoints. TCP probes avoid
      # reusable credentials in headers, but verify only that 9093 listens.
      startup_probe {
        transport               = "TCP"
        port                    = 9093
        interval_seconds        = 5
        failure_count_threshold = 12
        timeout                 = 2
      }

      liveness_probe {
        transport               = "TCP"
        port                    = 9093
        interval_seconds        = 30
        failure_count_threshold = 3
        timeout                 = 2
      }

      readiness_probe {
        transport               = "TCP"
        port                    = 9093
        interval_seconds        = 10
        failure_count_threshold = 3
        success_count_threshold = 1
        timeout                 = 2
      }
    }
  }

  # Azure terminates public TLS; the container serves internal HTTP on 9093.
  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 9093
    transport                  = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  tags = local.alertmanager_tags
}
