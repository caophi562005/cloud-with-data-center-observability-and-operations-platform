# Retained library module: DEV/TEST root intentionally does not call it.
# A future caller must configure AzureRM (features {}) and AzAPI providers
# for the intended subscription and pass private bcrypt inputs explicitly.
# This module must not own a backend or provider authentication configuration.
terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.8.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.13.0"
    }
  }
}
