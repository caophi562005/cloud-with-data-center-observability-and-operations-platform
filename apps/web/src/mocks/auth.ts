import type { AuthClient } from "../features/auth/auth.types";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const authMock: AuthClient = {
  async signIn({ email }) {
    await delay(650);
    return { email: email.trim(), provider: "password" };
  },

  async signInWithGoogle() {
    await delay(650);
    return { email: "google-user@example.com", provider: "google" };
  },

  async signOut() {
    await delay(150);
  },
};
