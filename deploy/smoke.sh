#!/bin/sh
# CI smoke test of the images (.github/workflows/web.yml): Postgres, the launcher and the web server as in
# docker-compose.yml (no Caddy, no Google Cloud: secrets from the environment), then one runtime container started
# through the launcher. Run from the repository root after the images opaya-web:ci and opaya-runtime:ci are built.
set -eu
users=$(mktemp -d /tmp/opaya-users-XXXX)
sudo chown 10001:10001 "$users" && sudo chmod 0700 "$users"
cleanup() {
  docker rm -f opaya-smoke-web opaya-smoke-launcher opaya-smoke-pg >/dev/null 2>&1 || true
  docker ps -aq --filter label=dev.opaya.role=runtime | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm opaya-smoke >/dev/null 2>&1 || true
  docker volume rm opaya-smoke-launcher >/dev/null 2>&1 || true
  sudo rm -rf "$users"
}
trap cleanup EXIT
docker network create opaya-smoke >/dev/null
docker volume create opaya-smoke-launcher >/dev/null
docker run -d --name opaya-smoke-pg --network opaya-smoke -e POSTGRES_DB=opaya -e POSTGRES_USER=opaya -e POSTGRES_PASSWORD=smoke postgres:18-alpine >/dev/null
docker run -d --name opaya-smoke-launcher --network none --user 0:0 --read-only --cap-drop ALL --cap-add CHOWN \
  -v /var/run/docker.sock:/var/run/docker.sock -v opaya-smoke-launcher:/run/opaya-launcher \
  -e OPAYA_USERS_HOST_DIR="$users" -e OPAYA_RUNTIME_IMAGE=opaya-runtime:ci -e OPAYA_RUNTIME_NETWORK=opaya-smoke-runtime \
  opaya-web:ci node dist/launcher-main.js >/dev/null
key=$(docker run --rm opaya-web:ci node --input-type=module -e "const m=await import('./dist/entitlements.js');console.log(JSON.stringify(await m.newKey('smoke')))")
i=0; until docker exec opaya-smoke-pg pg_isready -U opaya -d opaya >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 60 ] || { echo "Postgres did not start."; exit 1; }; sleep 1; done
docker run -d --name opaya-smoke-web --network opaya-smoke -p 127.0.0.1:3000:3000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -e DATABASE_URL=postgres://opaya:smoke@opaya-smoke-pg:5432/opaya -e BETTER_AUTH_SECRET=smoke-secret-0123456789abcdef0123456789 \
  -e ENTITLEMENTS_PRIVATE_KEY="$key" -e OPAYA_BASE_URL=http://localhost:3000 -e OPAYA_USERS_DIR=/users -e OPAYA_LAUNCHER_DIR=/run/opaya-launcher \
  -v "$users":/users -v opaya-smoke-launcher:/run/opaya-launcher opaya-web:ci >/dev/null
i=0; until curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 60 ] || { docker logs opaya-smoke-web; exit 1; }; sleep 1; done
curl -fsS http://127.0.0.1:3000/api/auth/ok; echo
curl -fsS -o /dev/null -w "pricing %{http_code}\n" http://127.0.0.1:3000/pricing
# A runtime through the launcher, as the WebSocket relay starts one.
docker exec opaya-smoke-web node --input-type=module -e "
const { RuntimeManager, launcherConnection } = await import('./dist/runtime/manager.js');
const { kmsSecretStore, localKeyWrapper } = await import('./dist/secret-store.js');
const { postgres } = await import('./dist/db.js');
const db = postgres(process.env.DATABASE_URL), kms = localKeyWrapper();
const manager = new RuntimeManager({ usersDir: '/users', launcher: launcherConnection('/run/opaya-launcher'), secrets: org => kmsSecretStore({ db, kms, organizationId: org }), startTimeoutMs: 90000 });
const service = await manager.attach({ id: 'smokeUser0001', organizationId: 'org_smoke', hostLimit: 5 }, {});
const snapshot = await service.call('snapshot');
if (snapshot.runtime !== 'web') throw new Error('The runtime is not in web mode.');
let refused = false;
try { await service.call('terminalOpen', { local: true }); } catch (error) { refused = /web app/.test(error.message); }
if (!refused) throw new Error('A local terminal opened in a runtime.');
const host = await service.call('saveHost', { name: 'smoke', hostname: '203.0.113.5', username: 'root', port: 22 });
console.log('runtime ok:', snapshot.runtime, host.name);
await db.destroy(); process.exit(0);
"
# The runtime keeps running after the manager's process ends: check its options, then stop it through the launcher.
runtime=$(docker ps -q --filter label=dev.opaya.role=runtime)
[ -n "$runtime" ] || { echo "No runtime container is running."; exit 1; }
docker inspect "$runtime" --format 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} privileged={{.HostConfig.Privileged}} network={{.HostConfig.NetworkMode}} binds={{.HostConfig.Binds}}'
[ "$(docker inspect "$runtime" --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{.Config.User}}')" = "true false 10001:10001" ] || { echo "Unexpected runtime options."; exit 1; }
docker logs "$runtime" 2>&1 | tail -5
echo "Smoke test passed."
