output "alertmanager_container_app_name" {
  description = "Name of the DEV/TEST Alertmanager Container App."
  value       = azurerm_container_app.alertmanager.name
}

output "alertmanager_fqdn" {
  description = "Default public Alertmanager hostname; available after creation."
  value       = azurerm_container_app.alertmanager.ingress[0].fqdn
}

output "alertmanager_url" {
  description = "Public HTTPS Alertmanager URL; native Basic Auth required, credentials are not included."
  value       = "https://${azurerm_container_app.alertmanager.ingress[0].fqdn}"
}
