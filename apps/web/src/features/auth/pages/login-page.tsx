import type { JSX } from "react";
import { AuthLayout } from "../../../app/layouts/auth-layout";
import { AuthBrandPanel } from "../components/auth-brand-panel";
import { LoginForm } from "../components/login-form";

export function LoginPage(): JSX.Element {
  return (
    <AuthLayout>
      <AuthBrandPanel />
      <LoginForm />
    </AuthLayout>
  );
}
