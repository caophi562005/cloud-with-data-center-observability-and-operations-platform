# OpsGrid Terraform Identity Infrastructure Design

## Status

The architecture was approved in conversation on 2026-09-30. This written specification is ready for review before implementation planning.

## Scope

Create the Phase 1 Identity infrastructure for the CloudOps project, branded **OpsGrid**, using Terraform. The change creates a reusable Cognito module and one deployable development root configuration. It does not change React or NestJS source code and does not provision infrastructure for later phases.

In scope:

- `infra/terraform/modules/cognito` reusable module.
- `infra/terraform/environments/dev/persistent/identity` deployable root.
- Explicit local Terraform state for the identity root.
- Cognito User Pool, confidential Cognito User Pool Client, optional Google IdP, and optional Cognito managed-login domain.
- Terraform README, example variables, formatting/validation workflow, and Terraform state/secret ignore rules.

Out of scope:

- Remote state bootstrap, S3 backend, DynamoDB lock table, or Secrets Manager.
- React or NestJS implementation changes.
- VPC, ECS, EKS, EC2, RDS, Redis, ALB, monitoring, logging, metrics, or application storage.
- Cognito Groups as an RBAC source of truth.
- Registration, password reset, MFA UX, challenge UI, or BFF session-store implementation.

## Repository findings and conventions

- The repository currently has `apps/web`, `apps/api`, `docs`, and no tracked `infra` directory.
- The API currently listens on `process.env.PORT ?? 3000`; the Vite development frontend uses its normal `5173` port.
- Existing durable design and plan documents live under `docs/superpowers/specs` and `docs/superpowers/plans`.
- The root `.gitignore` currently ignores only `.mnemon` and `.worktrees`; Terraform-specific ignore rules will be added without changing existing application conventions.

## Architecture and state boundaries

The repository will contain:

```text
infra/
└── terraform/
    ├── README.md
    ├── modules/
    │   └── cognito/
    │       ├── main.tf
    │       ├── variables.tf
    │       ├── outputs.tf
    │       └── versions.tf
    └── environments/
        └── dev/
            └── persistent/
                └── identity/
                    ├── backend.tf
                    ├── main.tf
                    ├── providers.tf
                    ├── variables.tf
                    ├── outputs.tf
                    ├── versions.tf
                    └── terraform.tfvars.example
```

There is intentionally no `bootstrap/` directory. The current project uses local state until remote state requirements are defined.

The identity root explicitly uses the local backend:

```hcl
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
```

The resulting state is local to the root at `infra/terraform/environments/dev/persistent/identity/terraform.tfstate` and is ignored by Git. A future `environments/dev/e2e` root will have its own configuration and state; it will never share the persistent identity state. A later migration to S3 can be performed from this root with Terraform state migration, without moving Cognito resources into an E2E state.

## Terraform versions and provider

Both the module and environment root declare:

- Terraform `>= 1.6.0, < 2.0.0`.
- HashiCorp AWS provider `~> 6.0`.

The implementation will use current AWS provider resource attributes for `aws_cognito_user_pool`, `aws_cognito_user_pool_client`, `aws_cognito_identity_provider`, and `aws_cognito_user_pool_domain`. Provider documentation was checked before choosing the resource model. The local toolchain currently reports Terraform `1.14.7`.

The environment configures the AWS provider region from `var.aws_region`. The module does not configure a provider or region itself.

## Cognito module

`modules/cognito` is the only location that declares Cognito resources. It is reusable and receives project/environment identity rather than hardcoding `opsgrid` or `dev`.

### User Pool

The module creates one `aws_cognito_user_pool` named `${project_name}-${environment}` with:

- `username_attributes = ["email"]`.
- Case-insensitive username configuration.
- Required standard `email` attribute.
- Optional mutable standard `name` attribute.
- `auto_verified_attributes = ["email"]`.
- Cognito-managed email sending appropriate for development.
- Verification message configuration using a confirmation code.
- Password minimum length of 12, with lowercase, uppercase, and numeric requirements; symbols are not mandatory for developer usability.
- Deletion protection inactive for development cleanup.
- No `prevent_destroy` lifecycle rule.
- No Cognito groups.
- No mandatory MFA configuration in this phase; MFA/challenge UX is a separate application concern.

The User Pool answers “who is this user?” only. Organization membership and `ADMIN`, `OPERATOR`, and `VIEWER` authorization remain in NestJS/PostgreSQL.

### Confidential BFF App Client

The current environment uses one server-side confidential client for the NestJS BFF:

```hcl
generate_secret = true
prevent_user_existence_errors = "ENABLED"
enable_token_revocation       = true
```

The reusable module has an `enable_user_password_auth` switch and the development root enables it. The resulting client allows:

```hcl
explicit_auth_flows = [
  "ALLOW_USER_PASSWORD_AUTH",
  "ALLOW_REFRESH_TOKEN_AUTH",
]
```

The React custom login form posts credentials to a NestJS BFF endpoint. NestJS calls Cognito `InitiateAuth` with `USER_PASSWORD_AUTH`, including `USERNAME`, `PASSWORD`, and the `SECRET_HASH` calculated from the confidential client secret. Cognito tokens are retained by the BFF session boundary and are not returned to the browser.

The client secret is never output, placed in frontend configuration, or committed. Terraform state still contains the AWS-created secret and therefore must be protected even though it is ignored by Git.

### Optional OAuth and managed login

The same confidential client can later support Google and managed login. `create_user_pool_domain` is false by default in the module/root until a unique prefix is supplied. When enabled, the module:

- Creates `aws_cognito_user_pool_domain` using `cognito_domain_prefix` with managed login version 2.
- Applies Cognito-provided managed-login branding to the confidential client with `aws_cognito_managed_login_branding`.
- Enables OAuth for the client.
- Allows only Authorization Code flow; implicit flow is not configured.
- Allows only `openid`, `email`, and `profile` scopes.
- Uses configurable callback and logout URL lists.
- Supports PKCE at the NestJS BFF as an additional protection.

The development defaults are:

```hcl
callback_urls = [
  "http://localhost:3000/auth/callback"
]

logout_urls = [
  "http://localhost:5173/login"
]
```

The callback is owned by NestJS. The logout redirect returns the browser to the React login page after the BFF clears its session. Neither URL is hardcoded inside the module.

### Optional Google IdP

`enable_google_identity_provider` is false by default. When enabled, the module creates `aws_cognito_identity_provider.google` and requires non-empty `google_client_id` and `google_client_secret` values as well as an enabled managed-login domain.

The Google provider uses the minimum requested scopes:

```text
openid email profile
```

Google credentials are variables only; they are not committed to `terraform.tfvars.example` and are not module outputs. The Google client secret will still be present in Terraform state when the provider resource is enabled.

Google login uses the OAuth Authorization Code path:

```text
React → NestJS BFF → Cognito /oauth2/authorize → Google
Google → Cognito → NestJS callback
NestJS → Cognito /oauth2/token
```

The OAuth token endpoint authentication method is selected by NestJS as `client_secret_basic` or `client_secret_post`; Terraform only provisions the confidential client and does not expose the secret.

### Module variables

The module exposes a small, purposeful interface:

- `project_name`: non-empty project identifier.
- `environment`: non-empty environment identifier.
- `callback_urls`: absolute HTTP(S) callback URLs without fragments; HTTP is intended only for localhost development.
- `logout_urls`: absolute HTTP(S) logout URLs without fragments; HTTP is intended only for localhost development.
- `generate_secret`: confidential/public client switch; the current root sets it to `true`.
- `enable_user_password_auth`: controls `ALLOW_USER_PASSWORD_AUTH`; current root sets it to `true`.
- `create_user_pool_domain`: managed-login/OAuth domain switch.
- `cognito_domain_prefix`: nullable validated Cognito prefix, required when the domain is enabled.
- `enable_google_identity_provider`: Google switch.
- `google_client_id`: nullable Google client id.
- `google_client_secret`: nullable sensitive Google secret.
- `additional_tags`: optional map merged into common tags.

Validation rejects invalid project/environment names, malformed URLs, invalid domain prefixes, missing Google credentials when Google is enabled, and Google/domain combinations that cannot work.

## Environment root

`environments/dev/persistent/identity` owns the local state and passes project-specific configuration to the module. Its project name is `opsgrid`, environment is `dev`, and it does not duplicate Cognito resources.

The root exposes the variables needed for local development and BFF integration:

- `project_name`, default `opsgrid`.
- `environment`, default `dev`.
- `aws_region`.
- `callback_urls`, defaulting to the NestJS callback.
- `logout_urls`, defaulting to the React login page.
- `create_user_pool_domain`, default `false` until a unique prefix is supplied.
- `cognito_domain_prefix`, nullable.
- `enable_google_identity_provider`, default `false`.
- `google_client_id`, nullable.
- `google_client_secret`, nullable and sensitive.
- `additional_tags`, default `{}`.

The root passes `generate_secret = true` and `enable_user_password_auth = true` explicitly to make the BFF decision visible in composition. A later public-client use of the reusable module would be an intentional separate configuration, not the current environment behavior.

`terraform.tfvars.example` contains only non-secret configuration and comments for Google values. It does not contain fake credentials or a client secret.

## Outputs

The module and root output:

- `user_pool_id`.
- `user_pool_arn`.
- `user_pool_client_id`.
- `issuer_url` from the User Pool's computed endpoint.
- `cognito_domain`, `null` when disabled.
- `oauth_authorize_url`, `null` when the domain is disabled.
- `oauth_token_endpoint`, `null` when the domain is disabled.

No client secret or Google secret is an output.

NestJS uses the pool id, client id, issuer, and domain/token endpoint when OAuth is enabled. The NestJS runtime separately receives the client secret through local ignored `.env` configuration or an external secret store. React does not consume Cognito credentials or tokens; it consumes BFF endpoints and a session cookie.

## Tags

Resources receive these common tags:

```text
Project     = project_name
Environment = environment
ManagedBy   = terraform
Component   = identity
```

`additional_tags` can extend the map without allowing callers to replace the required identity tags.

## Security and lifecycle behavior

- The client secret is generated by Cognito and must be transferred to NestJS out of band after apply.
- Terraform state is sensitive and ignored by Git; it still needs filesystem and backup protection.
- No credentials are stored in the example tfvars file or frontend bundle.
- No client secret is output.
- No `prevent_destroy` is used.
- User Pool deletion protection is inactive so development can be destroyed.
- Destruction order for future infrastructure is `e2e` first, `persistent` second. There is no bootstrap state to destroy.

For the custom React form, the later NestJS implementation must use HTTPS, avoid logging request bodies, redact APM/tracing/error payloads, rate-limit authentication, use POST rather than URL credentials, and return only a secure session cookie. Cognito challenges such as `NEW_PASSWORD_REQUIRED` or MFA are application flow work and are not implemented by this Terraform task.

## Documentation and verification

`infra/terraform/README.md` will document:

- The `modules`, `environments`, `persistent`, and future `e2e` boundaries.
- Why `bootstrap` is intentionally absent.
- Local state initialization and the future remote-state migration point.
- The BFF custom-login flow and confidential client secret handoff.
- Google enablement requirements.
- `terraform init`, `fmt`, `validate`, `plan`, `apply`, and `destroy` commands.
- State/secret handling and destroy order.
- Explicit Phase 1 exclusions.

Before completion, run Terraform formatting and validation from the repository. If AWS credentials are unavailable, formatting and validation can still be reported, but no apply success will be claimed.
