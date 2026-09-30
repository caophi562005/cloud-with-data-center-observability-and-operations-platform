export type SignInInput = {
  email: string;
  password: string;
  rememberMe: boolean;
};

export type AuthUser = {
  email: string;
  provider: "password" | "google";
};

export interface AuthClient {
  signIn(input: SignInInput): Promise<AuthUser>;
  signInWithGoogle(): Promise<AuthUser>;
  signOut(): Promise<void>;
}
