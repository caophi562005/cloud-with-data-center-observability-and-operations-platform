import type { Role } from "../../types/domain";

export type LoginInput = {
  email: string;
  password: string;
};

export type RegisterInput = {
  email: string;
  displayName: string;
  password: string;
  confirmPassword: string;
};

export type ConfirmRegistrationInput = {
  email: string;
  confirmationCode: string;
};

export type RegistrationResponse = {
  status: "CONFIRMATION_REQUIRED" | "CONFIRMED";
  email?: string;
  destination?: string;
};

export type SafeUser = {
  id: string;
  email: string;
  displayName: string | null;
};

export type MeOrganization = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

export type MeResponse = {
  user: SafeUser;
  organizations: MeOrganization[];
};

export type LoginResponse = {
  user: SafeUser;
};
