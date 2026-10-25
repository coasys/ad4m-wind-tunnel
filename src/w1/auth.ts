/**
 * W1 helper: give WE a session without the connect UI.
 *
 * ad4m-connect keeps its session in localStorage under keys prefixed by its own package version
 * (`setLocal` writes `${version}/${key}`; see ad4m connect/src/utils.ts and core.ts constructor):
 *   `<v>/ad4m-url`   — the executor base URL it last connected to (the token is only sent there)
 *   `<v>/ad4m-port`  — the executor port
 *   `<v>/ad4m-token` — the capability token
 * Seeding those before the app loads is exactly the state a returning WE user is in.
 *
 * The token is a real capability JWT minted the way ad4m-connect's own flow ends
 * (requestCapability → permitCapability → generateJwt), with the capabilities WE asks for
 * (`apps/we-web/src/platform/ad4mConnector.ts`: `{ with: { domain: '*', pointers: ['*'] }, can: ['*'] }`),
 * so the executor checks every call against a JWT, as it does for a real WE session — not the admin
 * credential, which skips capability checks.
 */

import { InstrumentedClient } from "../client.js";

/** WE's app info and capability request, as `ad4mConnector.ts` declares them. */
const WE_AUTH_INFO = {
  appName: "WE",
  appDesc: "Social media for the new internet",
  appDomain: "ad4m.weco.io",
  appUrl: "ad4m.weco.io",
  appIconPath: "https://avatars.githubusercontent.com/u/34165012",
  capabilities: [{ with: { domain: "*", pointers: ["*"] }, can: ["*"] }],
};

export async function mintWeJwt(admin: InstrumentedClient): Promise<string> {
  const requestId = await admin.call<string>("agent.requestCapability", { authInfo: WE_AUTH_INFO });
  const rand = await admin.call<string>("agent.permitCapability", {
    auth: JSON.stringify({ requestId, auth: WE_AUTH_INFO }),
  });
  return admin.call<string>("agent.generateJwt", { requestId, rand });
}

/** The localStorage entries a returning WE web user has, for ad4m-connect `connectVersion`. */
export function connectSessionStorage(connectVersion: string, port: number, token: string): Record<string, string> {
  return {
    [`${connectVersion}/ad4m-url`]: `http://localhost:${port}`,
    [`${connectVersion}/ad4m-port`]: String(port),
    [`${connectVersion}/ad4m-token`]: token,
  };
}
