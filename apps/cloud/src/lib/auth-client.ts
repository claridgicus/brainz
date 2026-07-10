/** Better Auth browser client (same-origin baseURL). Passwordless: magic link. */
import { createAuthClient } from "better-auth/svelte";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});
