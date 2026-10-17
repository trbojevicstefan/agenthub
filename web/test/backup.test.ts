import assert from "node:assert/strict";
import { test } from "node:test";
import { upload } from "../src/backup.js";

const auth = { getRequestHeaders: async () => new Headers({ Authorization: "Bearer test" }) };
const body = () => new Blob([new Uint8Array(4096)]).stream();

test("a backup goes to the bucket and never replaces an existing object", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({ name: "postgres/a.dump", size: "4096" });
  }) as unknown as typeof fetch;
  const object = await upload({ bucket: "opaya-backups", name: "postgres/a.dump", body: body(), auth: auth as never, fetchImpl });
  assert.equal(object.size, "4096");
  assert.match(seen!.url, /\/b\/opaya-backups\/o\?uploadType=media&ifGenerationMatch=0&name=postgres%2Fa\.dump$/);
  assert.equal(new Headers(seen!.init.headers).get("authorization"), "Bearer test");
});

test("bad names, refused uploads and empty dumps fail", async () => {
  const ok = (async () => Response.json({ name: "x", size: "10" })) as unknown as typeof fetch;
  await assert.rejects(upload({ bucket: "Bad Bucket", name: "a", body: body(), auth: auth as never, fetchImpl: ok }), /bucket name/);
  await assert.rejects(upload({ bucket: "opaya-backups", name: "../a", body: body(), auth: auth as never, fetchImpl: ok }), /object name/);
  await assert.rejects(upload({ bucket: "opaya-backups", name: "a", body: body(), auth: auth as never, fetchImpl: ok }), /only 10 bytes/);
  const refused = (async () => new Response("exists", { status: 412 })) as unknown as typeof fetch;
  await assert.rejects(upload({ bucket: "opaya-backups", name: "a", body: body(), auth: auth as never, fetchImpl: refused }), /HTTP 412/);
});
