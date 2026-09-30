export const queryKeys = {
  me: ["me"] as const,
  organization: (id: string) => ["organization", id] as const,
  members: (id: string) => ["members", id] as const,
};
