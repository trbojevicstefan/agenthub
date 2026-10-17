import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, pull, purgeTombstones, push } from "../src/sync.js";
import { setup, startTrial, verifiedUser } from "./helpers.js";

const host = (id: string, name: string) => ({ kind: "host", id, data: { name, hostname: "203.0.113.5", username: "root", port: 22 } });

test("records get revs, pulls page through changes, the last writer wins and deletes are tombstones", async t => {
  const env = await setup();
  t.after(env.close);
  let r = await push(env.db, "org_a", [host("h1", "one"), host("h2", "two")]);
  assert.deepEqual(r.revs.map(x => x.rev), [1, 2]);
  assert.deepEqual((await pull(env.db, "org_a", 0)).records.map(x => x.id), ["h1", "h2"]);
  assert.deepEqual((await pull(env.db, "org_b", 0)).records, [], "organizations are separate");
  // Two clients change h1; the server keeps the one it gets last.
  await push(env.db, "org_a", [host("h1", "from desktop")]);
  await push(env.db, "org_a", [host("h1", "from web")]);
  let changes = await pull(env.db, "org_a", 2);
  assert.deepEqual(changes.records.map(x => [x.id, (x.data as { name: string }).name]), [["h1", "from web"]]);
  assert.equal(changes.rev, 4);
  r = await push(env.db, "org_a", [{ kind: "host", id: "h2", deleted: true }]);
  changes = await pull(env.db, "org_a", 4);
  assert.deepEqual(changes.records, [{ kind: "host", id: "h2", rev: 5, deleted: true }]);
  assert.deepEqual((await pull(env.db, "org_a", 0)).records.map(x => x.id), ["h1"], "a new client gets no tombstones");

  // Old tombstones go; a client older than them starts again.
  await env.db.updateTable("opaya_sync_record").set({ updated_at: new Date(Date.now() - 91 * 86400_000) }).where("deleted", "=", true).execute();
  assert.equal(await purgeTombstones(env.db), 1);
  const stale = await pull(env.db, "org_a", 3);
  assert.equal(stale.reset, true);
  assert.deepEqual(stale.records.map(x => x.id), ["h1"]);
  assert.equal((await pull(env.db, "org_a", 99)).reset, true, "a rev this server never gave starts again too");

  // Paging.
  await push(env.db, "org_c", Array.from({ length: LIMITS.page + 10 }, (_, i) => host(`h${i}`, `n${i}`)).slice(0, LIMITS.push));
  await push(env.db, "org_c", Array.from({ length: 10 }, (_, i) => host(`x${i}`, `n${i}`)));
  const first = await pull(env.db, "org_c", 0);
  assert.equal(first.records.length, LIMITS.page);
  assert.equal(first.more, true);
  const second = await pull(env.db, "org_c", first.rev);
  assert.equal(second.records.length, 10);
  assert.equal(second.more, false);
});

test("bad records and records over the limits are refused, and nothing is stored", async t => {
  const env = await setup();
  t.after(env.close);
  await assert.rejects(push(env.db, "org_a", [{ kind: "file", id: "a", data: {} }]), /Unknown record kind/);
  await assert.rejects(push(env.db, "org_a", [{ kind: "host", id: "../a", data: {} }]), /Invalid record ID/);
  await assert.rejects(push(env.db, "org_a", [{ kind: "host", id: "a" }]), /needs data/);
  await assert.rejects(push(env.db, "org_a", [host("ok", "fine"), { kind: "host", id: "big", data: { x: "y".repeat(LIMITS.record) } }]), /larger than the sync limit/);
  await push(env.db, "org_a", [{ kind: "transcript", id: "t", data: { messages: ["y".repeat(LIMITS.record)] } }]); // a transcript may be up to 1 MB
  await assert.rejects(push(env.db, "org_a", Array.from({ length: LIMITS.push + 1 }, (_, i) => host(`h${i}`, "x"))), /At most/);
  assert.deepEqual((await pull(env.db, "org_a", 0)).records.map(x => x.kind), ["transcript"]);
});

test("the desktop app syncs with its session when the plan has sync; secret values go to the KMS store", async t => {
  const env = await setup({ runtime: { usersDir: "/tmp/unused", launcherDir: "", kmsKey: "", egressIp: "" } });
  t.after(env.close);
  const { browser, organizationId } = await verifiedUser(env);
  let response = await browser.fetch("/api/sync?since=0");
  assert.equal(response.status, 403, "Free has no sync");
  await startTrial(env, browser, organizationId);
  response = await browser.fetch("/api/sync", { json: { records: [host("h1", "vps")] } });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { rev: number }).rev, 1);
  response = await browser.fetch("/api/sync?since=0");
  assert.deepEqual(((await response.json()) as { records: { id: string }[] }).records.map(r => r.id), ["h1"]);
  response = await browser.fetch("/api/sync", { json: { records: [{ kind: "host", id: "big", data: { x: "y".repeat(LIMITS.record) } }] } });
  assert.equal(response.status, 413);

  const key = "opaya-secret-0f8fad5b-d9cb-469f-a165-70867728950e";
  response = await browser.fetch("/api/sync/secrets", { json: { key, value: JSON.stringify("sk-live-1") } });
  assert.equal(response.status, 200);
  assert.equal(await env.store(organizationId).get(key), JSON.stringify("sk-live-1"));
  assert.equal((await browser.fetch("/api/sync/secrets", { json: { key: "agent_token", value: "x" } })).status, 400, "only Vault key names");
  await browser.fetch("/api/sync/secrets", { json: { key } });
  assert.equal(await env.store(organizationId).has(key), false);
});
