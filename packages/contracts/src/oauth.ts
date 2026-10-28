/**
 * OAuth 2.1 wire shapes for the Brainz Cloud authorization server (Wave OA,
 * SPEC-CLOUD.md "OAuth 2.1 for remote MCP").
 *
 * These are the RFC shapes the directory clients (Claude, ChatGPT, Claude
 * Code) read: protected-resource metadata (RFC 9728), authorization-server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), the token
 * response and error body (RFC 6749). Objects are passthrough — the RFCs allow
 * extra members — but every member Brainz relies on is pinned here.
 */
import { z } from "zod";

/** The one OAuth scope Brainz grants: act on one vault as the signing-in user. */
export const OAUTH_VAULT_SCOPE = "vault";

/** RFC 9728 protected-resource metadata, served for `/mcp`. */
export const oauthProtectedResourceMetadataSchema = z
  .object({
    resource: z.string().url(),
    authorization_servers: z.array(z.string().url()).min(1),
    scopes_supported: z.array(z.string()),
    bearer_methods_supported: z.array(z.literal("header")),
    resource_name: z.string().optional(),
    resource_documentation: z.string().url().optional(),
  })
  .passthrough();
export type OAuthProtectedResourceMetadata = z.infer<typeof oauthProtectedResourceMetadataSchema>;

export const oauthTokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_post",
  "client_secret_basic",
]);
export type OAuthTokenEndpointAuthMethod = z.infer<typeof oauthTokenEndpointAuthMethodSchema>;

/** RFC 8414 authorization-server metadata. */
export const oauthAuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url(),
    revocation_endpoint: z.string().url(),
    response_types_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.literal("S256")),
    token_endpoint_auth_methods_supported: z.array(oauthTokenEndpointAuthMethodSchema),
    revocation_endpoint_auth_methods_supported: z.array(oauthTokenEndpointAuthMethodSchema),
    scopes_supported: z.array(z.string()),
    client_id_metadata_document_supported: z.boolean(),
    service_documentation: z.string().url().optional(),
  })
  .passthrough();
export type OAuthAuthorizationServerMetadata = z.infer<typeof oauthAuthorizationServerMetadataSchema>;

/** RFC 7591 client registration request (the members Brainz honours). */
export const oauthClientRegistrationRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
    token_endpoint_auth_method: oauthTokenEndpointAuthMethodSchema.optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().max(2000).optional(),
    logo_uri: z.string().max(2000).optional(),
    scope: z.string().max(500).optional(),
  })
  .passthrough();
export type OAuthClientRegistrationRequest = z.infer<typeof oauthClientRegistrationRequestSchema>;

/** RFC 7591 client information response. `client_secret` only for confidential clients. */
export const oauthClientRegistrationResponseSchema = z
  .object({
    client_id: z.string(),
    client_id_issued_at: z.number().int(),
    client_secret: z.string().optional(),
    client_secret_expires_at: z.number().int().optional(),
    redirect_uris: z.array(z.string()),
    token_endpoint_auth_method: oauthTokenEndpointAuthMethodSchema,
    grant_types: z.array(z.string()),
    response_types: z.array(z.string()),
    client_name: z.string().optional(),
  })
  .passthrough();
export type OAuthClientRegistrationResponse = z.infer<typeof oauthClientRegistrationResponseSchema>;

/** RFC 6749 §5.1 successful token response. Brainz always issues a refresh token. */
export const oauthTokenResponseSchema = z.object({
  access_token: z.string().regex(/^bzat_[A-Za-z0-9]{40}$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().regex(/^bzrt_[A-Za-z0-9]{40}$/),
  scope: z.string(),
});
export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

/** RFC 6749 §5.2 error codes (+ RFC 8707 invalid_target, RFC 7591 registration errors). */
export const oauthErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "invalid_target",
  "access_denied",
  "server_error",
  "invalid_redirect_uri",
  "invalid_client_metadata",
]);
export type OAuthErrorCode = z.infer<typeof oauthErrorCodeSchema>;

export const oauthErrorSchema = z.object({
  error: oauthErrorCodeSchema,
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof oauthErrorSchema>;
