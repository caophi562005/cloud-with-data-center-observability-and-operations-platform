import type { JSX } from "react";
import { AuthLayout } from "../../../app/layouts/auth-layout";
import { AuthBrandPanel } from "../components/auth-brand-panel";
import { RegisterForm } from "../components/register-form";

export function RegisterPage(): JSX.Element {
  return (
    <AuthLayout>
      <AuthBrandPanel />
      <RegisterForm />
    </AuthLayout>
  );
}
