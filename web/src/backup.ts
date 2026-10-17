// Sends a database dump from standard input to the Google Cloud Storage backup bucket.
//   pg_dump ... | node dist/backup.js postgres/opaya-2026-11-01T030000Z.dump
// The service account needs only roles/storage.objectCreator on the bucket. The object must not exist yet, so a backup
// can never replace an older one.
import { Readable } from "node:stream";
import { GoogleAuth } from "google-auth-library";

export async function upload({ bucket, name, body, auth, fetchImpl = fetch }: { bucket: string; name: string; body: ReadableStream<Uint8Array>; auth: Pick<GoogleAuth, "getRequestHeaders">; fetchImpl?: typeof fetch }) {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("OPAYA_BACKUP_BUCKET is not a valid bucket name.");
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes("..")) throw new Error("Invalid backup object name.");
  const headers = new Headers(await auth.getRequestHeaders());
  headers.set("Content-Type", "application/octet-stream");
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`;
  const response = await fetchImpl(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  if (!response.ok) throw new Error(`Cloud Storage refused the backup (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  const object = (await response.json()) as { name: string; size: string };
  if (Number(object.size) < 1024) throw new Error(`The backup ${object.name} has only ${object.size} bytes. Check pg_dump.`);
  return object;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2] ?? "";
  upload({
    bucket: process.env.OPAYA_BACKUP_BUCKET ?? "",
    name,
    body: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    auth: new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.read_write"] }),
  }).then(
    object => console.log(`Backup ${object.name} saved (${object.size} bytes).`),
    error => {
      console.error(String(error?.message || error));
      process.exit(1);
    },
  );
}
