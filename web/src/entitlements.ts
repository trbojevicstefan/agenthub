// Signed entitlements: what an organization's plan allows. The desktop app keeps the token and checks the signature
// offline (desktop/account.cjs), so it keeps its limits for 14 days without a connection.
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import type { Database } from "./db.js";
import { planState } from "./plan-state.js";

export const AUDIENCE = "opaya-desktop";
export const TOKEN_TYPE = "opaya-entitlements+jwt";
export const VALIDITY_SECONDS = 14 * 24 * 60 * 60;

export interface Entitlements {
  plan: string;
  status: string;
  trialEnd: number | null;
  limits: { hosts: number };
  features: { web: boolean; sync: boolean };
}

// ENTITLEMENTS_PRIVATE_KEY: one private Ed25519 JWK, or a JSON array of them. The first key signs; the public parts of
// all of them are published, so tokens signed with an older key stay valid while it is rotated out.
export async function createSigner(secret: string, issuer: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error("ENTITLEMENTS_PRIVATE_KEY is not JSON. Make it with: npm run entitlements:key --workspace web");
  }
  const jwks = (Array.isArray(parsed) ? parsed : [parsed]) as JWK[];
  if (!jwks.length || jwks.some(k => k.kty !== "OKP" || k.crv !== "Ed25519" || !k.d || !k.x || !k.kid)) throw new Error("ENTITLEMENTS_PRIVATE_KEY must hold private Ed25519 JWKs with a kid.");
  const current = jwks[0]!;
  const key = await importJWK(current, "EdDSA");
  const publicKeys = jwks.map(({ kty, crv, x, kid }) => ({ kty, crv, x, kid, alg: "EdDSA", use: "sig" }));
  return {
    jwks: { keys: publicKeys },
    async sign(subject: { userId: string; organizationId: string }, entitlements: Entitlements, now = Math.floor(Date.now() / 1000)) {
      const token = await new SignJWT({ org: subject.organizationId, ...entitlements })
        .setProtectedHeader({ alg: "EdDSA", kid: current.kid!, typ: TOKEN_TYPE })
        .setIssuer(issuer)
        .setAudience(AUDIENCE)
        .setSubject(subject.userId)
        .setIssuedAt(now)
        .setExpirationTime(now + VALIDITY_SECONDS)
        .sign(key);
      return { token, expiresAt: now + VALIDITY_SECONDS };
    },
  };
}
export type Signer = Awaited<ReturnType<typeof createSigner>>;

export async function newKey(kid = `opaya-${new Date().toISOString().slice(0, 10)}`) {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, kid, alg: "EdDSA" } as JWK;
}

export async function entitlementsFor(db: Database, organizationId: string): Promise<Entitlements> {
  const state = await planState(db, organizationId);
  return {
    plan: state.plan.name,
    status: state.status,
    trialEnd: state.status === "trialing" && state.trialEnd ? Math.floor(state.trialEnd.getTime() / 1000) : null,
    limits: { hosts: state.plan.limits.hosts },
    features: { ...state.plan.features },
  };
}
