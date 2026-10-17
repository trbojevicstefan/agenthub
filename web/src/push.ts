// Web Push for the web app: what the desktop app shows as OS notifications (a reply, an approval that waits, a finished
// job) reaches the user's browsers while no Opaya tab is in front. VAPID keys come from Secret Manager
// (WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY; make them with `npx web-push generate-vapid-keys`).
import { createHash } from "node:crypto";
import { sql } from "kysely";
import webpush from "web-push";
import type { Database } from "./db.js";

export const PUSH_TABLE = sql`create table if not exists opaya_push_subscription (
  id text primary key,
  user_id text not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
)`;

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}
type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

const MAX_SUBSCRIPTIONS = 10;
const B64URL = /^[A-Za-z0-9_-]{8,200}$/;

export function pushService({ db, publicKey, privateKey, subject = "mailto:support@opaya.dev", send = webpush.sendNotification as Send }: { db: Database; publicKey: string; privateKey: string; subject?: string; send?: Send }) {
  const options: webpush.RequestOptions = { vapidDetails: { subject, publicKey, privateKey }, TTL: 60 * 60, urgency: "normal" };
  return {
    publicKey,
    async subscribe(userId: string, input: unknown) {
      const sub = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      let url: URL;
      try {
        url = new URL(String(sub.endpoint ?? ""));
      } catch {
        throw new Error("Invalid push subscription.");
      }
      if (url.protocol !== "https:" || String(sub.endpoint).length > 1000 || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string" || !B64URL.test(sub.keys.p256dh) || !B64URL.test(sub.keys.auth)) throw new Error("Invalid push subscription.");
      const id = createHash("sha256").update(url.toString()).digest("hex");
      await db
        .insertInto("opaya_push_subscription")
        .values({ id, user_id: userId, endpoint: url.toString(), p256dh: sub.keys.p256dh, auth: sub.keys.auth })
        .onConflict(oc => oc.column("id").doUpdateSet({ user_id: userId, p256dh: sub.keys!.p256dh as string, auth: sub.keys!.auth as string }))
        .execute();
      // The newest ten browsers of a user.
      const old = await db.selectFrom("opaya_push_subscription").select("id").where("user_id", "=", userId).orderBy("created_at", "desc").offset(MAX_SUBSCRIPTIONS).limit(100).execute();
      if (old.length) await db.deleteFrom("opaya_push_subscription").where("id", "in", old.map(o => o.id as string)).execute();
      return true;
    },
    async unsubscribe(userId: string, endpoint: string) {
      await db.deleteFrom("opaya_push_subscription").where("user_id", "=", userId).where("endpoint", "=", endpoint).execute();
      return true;
    },
    async has(userId: string) {
      return Boolean(await db.selectFrom("opaya_push_subscription").select("id").where("user_id", "=", userId).executeTakeFirst());
    },
    async notify(userId: string, payload: PushPayload) {
      const subs = await db.selectFrom("opaya_push_subscription").selectAll().where("user_id", "=", userId).execute();
      const body = JSON.stringify({ title: payload.title.slice(0, 120), body: payload.body.slice(0, 240), tag: payload.tag ?? "opaya", url: payload.url ?? "/app/" });
      let sent = 0;
      for (const s of subs) {
        try {
          await send({ endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } }, body, options);
          sent++;
        } catch (error) {
          // The browser dropped the subscription.
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await db.deleteFrom("opaya_push_subscription").where("id", "=", s.id as string).execute();
        }
      }
      return sent;
    },
  };
}
export type PushService = ReturnType<typeof pushService>;
