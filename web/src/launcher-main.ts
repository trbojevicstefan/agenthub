// The launcher container's entry (deploy/docker-compose.yml, service "launcher").
import { createLauncher, dockerApi, serveLauncher } from "./launcher.js";

const env = process.env;
const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);
const launcher = createLauncher(
  {
    image: env.OPAYA_RUNTIME_IMAGE || "opaya-runtime:latest",
    network: env.OPAYA_RUNTIME_NETWORK || "opaya-runtime",
    usersHostDir: (env.OPAYA_USERS_HOST_DIR || "/var/lib/opaya/users").replace(/\/+$/, ""),
    uid: 10001,
    gid: 10001,
    memoryMb: number(env.OPAYA_RUNTIME_MEMORY_MB, 1024),
    cpus: number(env.OPAYA_RUNTIME_CPUS, 1),
    pids: number(env.OPAYA_RUNTIME_PIDS, 256),
  },
  dockerApi(env.DOCKER_SOCKET || "/var/run/docker.sock"),
);
await serveLauncher({ dir: env.OPAYA_LAUNCHER_DIR || "/run/opaya-launcher", launcher, uid: 10001, gid: 10001 });
console.log("Opaya launcher is ready.");
