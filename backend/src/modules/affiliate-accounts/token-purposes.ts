export const accountTokenPurpose = (id: string, field: "access" | "refresh") => `affiliate_account:${id}:${field}`;
export const authorizationTokenPurpose = (id: string, field: "access" | "refresh") =>
  `affiliate_authorization:${id}:${field}`;
