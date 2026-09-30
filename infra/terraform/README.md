# OpsGrid Terraform identity

This directory documents the Phase 1 identity infrastructure workflow for the `opsgrid` project. The deployable Terraform root is the development persistent identity stack; the reusable Cognito implementation is a separate module. This README is operational guidance only: repository code and documentation do **not** demonstrate that an AWS apply has succeeded. AWS credentials and a reachable AWS account are required for operations that contact AWS.

## Phase 1 scope

Phase 1 provisions only Cognito identity for the `opsgrid` project:

- one Cognito User Pool with email usernames and email verification;
- one confidential Cognito App Client for the NestJS BFF, with a Cognito-generated client secret;
- an optional Cognito managed-login domain and managed-login branding; and
- an optional Google identity provider.

The managed-login domain and Google provider are disabled by default. When managed login is enabled, the App Client uses OAuth Authorization Code (`code`) flow and the scopes `openid`, `email`, and `profile`. The BFF password flow uses Cognito `USER_PASSWORD_AUTH`; the client is configured for `ALLOW_USER_PASSWORD_AUTH` and refresh-token authentication.

Cognito Groups are intentionally not part of Phase 1. Tenant membership and RBAC belong in the NestJS application and PostgreSQL, not in this identity Terraform module.

## Module, deployable root, and state boundaries

The repository root project identifier is `opsgrid` (the deployable root defaults `project_name` to `opsgrid`). The Terraform layout has two distinct boundaries:

- `infra/terraform/modules/cognito` is the reusable module. It owns the Cognito resources and exposes non-secret identifiers and URLs.
- `infra/terraform/environments/dev/persistent/identity` is the deployable `dev` root. It supplies environment values, configures the AWS provider, calls the module, and owns the Phase 1 state.

Run Terraform commands from the deployable identity root:

```text
infra/terraform/environments/dev/persistent/identity
```

The `persistent/identity` stack has isolated state from a future `e2e` sibling stack. A future end-to-end stack must have its own root and state rather than sharing this state file. There is currently no `e2e` root in this Phase 1 implementation.

### Local state and intentionally absent bootstrap

The root's backend is explicitly local:

```text
backend "local" {
  path = "terraform.tfstate"
}
```

Therefore the state path is:

```text
infra/terraform/environments/dev/persistent/identity/terraform.tfstate
```

Local state is sufficient for this Phase 1 workflow, so there is intentionally no `bootstrap/` stack, no remote state backend, and no Terraform-managed Secrets Manager resource. Those absences are deliberate boundaries, not missing commands to run. State files and their backups can contain confidential values and must still be protected with filesystem access controls and secure handling.

The repository `.gitignore` ignores Terraform working directories (`**/.terraform/`), state (`*.tfstate` and `*.tfstate.*`), variable files (`*.tfvars`), and plan files (`*.tfplan`). The checked-in `terraform.tfvars.example` is explicitly excepted; the copied `terraform.tfvars` must remain local and must never be committed.

## Cognito resources and BFF flows

The Cognito module creates the User Pool and confidential BFF App Client. The App Client has `generate_secret = true`, `prevent_user_existence_errors = "ENABLED"`, token revocation enabled, and explicit authentication flows for refresh tokens plus the optional BFF password flow. The managed-login domain and its branding are conditional resources, as is the Google identity provider.

### Custom email/password login

The BFF handles Cognito credentials and tokens server-side and does not persist the password. The required sequence is:

```text
React form
  → NestJS POST /auth/login
  → Cognito InitiateAuth(USER_PASSWORD_AUTH)
  → SECRET_HASH calculated in NestJS
  → server-side session
  → HttpOnly/Secure cookie
```

React never receives the confidential client secret or Cognito tokens. NestJS must enforce HTTPS, accept credentials in the POST body only, never log passwords or request bodies, redact credentials and tokens from APM and application telemetry, rate-limit the login endpoint, issue secure cookies with appropriate session settings, and never persist tokens in `localStorage`.

`SECRET_HASH` is calculated in NestJS with the confidential App Client credentials before calling Cognito. The browser talks to the BFF; it does not call Cognito with the client secret.

### Optional Google login

When both the managed-login domain and Google provider are enabled, the browser uses OAuth Authorization Code flow through the Cognito domain. Cognito brokers the Google sign-in, then the BFF exchanges the authorization code at Cognito's token endpoint using `client_secret_basic` or `client_secret_post`. The configured scopes are `openid email profile`. NestJS validates and stores the resulting server-side session, then returns only the HttpOnly/Secure session cookie to the browser. The Google client secret and Cognito client secret must remain server-side.

## Client-secret handoff and state protection

The Cognito-generated confidential App Client secret is **not a Terraform output**. The root outputs expose the User Pool id and ARN, App Client id, issuer URL, and optional OAuth URLs, but not the client secret. The AWS provider can retain the generated secret in the local Terraform state because the state records resource attributes even when an attribute is not exposed as an output.

After a successful `terraform apply`, an operator must retrieve the secret through an approved AWS console or AWS CLI process and place it in an ignored local NestJS `.env` file or an approved external secret store. Phase 1 does not provision Secrets Manager; using an external store is an operator/application integration step, not a Terraform resource in this directory.

The secret must never appear in:

- Git, commits, or pull requests;
- `terraform.tfvars` checked into the repository;
- frontend environment variables or browser bundles;
- application logs, APM records, or diagnostic output; or
- captured terminal/output files.

Protect `terraform.tfstate`, any `terraform.tfstate.*` backups, and any other local state copies as confidential material. Do not paste state or secret values into tickets, chat, or code review. AWS credentials are also required for the AWS-contacting steps; this documentation does not imply that an apply has run or succeeded.

## Terraform workflow

Open PowerShell in the deployable root:

```powershell
Set-Location infra/terraform/environments/dev/persistent/identity
```

Copy the example variables, replace only with approved non-secret environment values, then initialize and validate:

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -check -recursive ..\..\..\..\..\..
terraform validate
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
terraform destroy -var-file=terraform.tfvars
```

The `terraform fmt -check -recursive ..\..\..\..\..\..` command is the exact identity-root check. Because the recursive path can be confusing when run from the identity root, the equivalent repository-root check is:

```powershell
terraform fmt -check -recursive infra/terraform
```

Run `plan`, `apply`, and `destroy` deliberately and review their output. The AWS provider must contact AWS for the relevant operations, so valid AWS credentials, permissions, and network access are required. `terraform init`, formatting, and local validation do not constitute a successful apply. A successful apply may be claimed only from the actual command result, not from the presence of these files or this README.

`terraform.tfvars` is ignored by Git and must never be committed. Do not put the Cognito client secret, Google client secret, or any other credential in the example file, committed Terraform files, frontend configuration, or command captures.

## Future destroy order

When a future end-to-end stack exists, destroy dependent resources before the persistent identity stack:

```text
e2e (future) → persistent identity → no bootstrap
```

The final `no bootstrap` step is intentional: Phase 1 has no bootstrap stack or remote-state infrastructure to destroy.

## Explicit Phase 2+ exclusions

The following infrastructure is outside Phase 1 and is not provisioned by this Terraform root or module:

- VPC networking;
- ECS;
- EKS;
- EC2;
- RDS;
- Redis;
- ALB;
- Prometheus;
- Grafana;
- the CloudWatch application stack; and
- application S3 storage.

Adding any of these requires a separately scoped plan, root, state boundary, credentials review, and operational documentation.
