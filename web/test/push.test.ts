import assert from "node:assert/strict";
import { test } from "node:test";
import { pushService } from "../src/push.js";
import { setup } from "./helpers.js";

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`, keys: { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa40HI80NM9OBhDBJ5yk", auth: "tBHItJI5svbpez7KI4CCXg" } });

test("browsers subscribe, get pushes, and dropped subscriptions are removed", async t => {
  const env = await setup();
  t.after(env.close);
  const sent: { endpoint: string; body: any; options: any }[] = [];
  let gone = "";
  const push = pushService({ db: env.db, publicKey: "pub", privateKey: "priv", send: async (s, body, options) => {
    if (s.endpoint === gone) throw Object.assign(new Error("gone"), { statusCode: 410 });
    sent.push({ endpoint: s.endpoint, body: JSON.parse(body), options });
  } });
  await assert.rejects(push.subscribe("u1", { endpoint: "http://insecure.example/x", keys: sub(1).keys }), /Invalid push subscription/);
  await assert.rejects(push.subscribe("u1", { endpoint: sub(1).endpoint, keys: { p256dh: "x", auth: "y" } }), /Invalid push subscription/);
  for (let i = 0; i < 12; i++) await push.subscribe("u1", sub(i));
  assert.equal((await env.db.selectFrom("opaya_push_subscription").selectAll().execute()).length, 10, "the newest ten");
  assert.equal(await push.has("u2"), false);
  assert.equal(await push.notify("u1", { title: "Hermes replied", body: "Done.", tag: "reply-1" }), 10);
  assert.deepEqual(sent[0]!.body, { title: "Hermes replied", body: "Done.", tag: "reply-1", url: "/app/" });
  assert.equal(sent[0]!.options.vapidDetails.subject, "mailto:support@opaya.dev");
  gone = sent[0]!.endpoint;
  await push.notify("u1", { title: "x", body: "y" });
  assert.equal((await env.db.selectFrom("opaya_push_subscription").selectAll().execute()).length, 9, "a 410 removes it");
  await push.unsubscribe("u1", sent[1]!.endpoint);
  assert.equal((await env.db.selectFrom("opaya_push_subscription").selectAll().execute()).length, 8);
});
