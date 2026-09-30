export type AuthenticatedUser = {
  cognitoSub: string;
  clientId: string;
  scope?: string;
  tokenUse: 'access';
};
