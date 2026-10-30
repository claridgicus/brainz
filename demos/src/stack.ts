/**
 * The running stack a demo records against.
 *
 * Brainz Cloud runs as a compose service (`compose.yaml`, service `cloud`):
 * the built worker under `wrangler dev --local`, its D1 and Durable Object
 * state on a tmpfs, so every stack starts empty. The recorder brings up a
 * fresh one for each run (`up`), and each demo signs up a demo account of
 * its own on it (`tenant.ts`). Nothing on the host serves anything; the
 * browser and the seed talk to the published port.
 *
 * The stack is named after the worktree (`brainz-demos-<dir>`) and its port
 * derived from the same name, so two worktrees record side by side.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** The compose project: one per worktree. */
export const projectName = (dir = root): string => {
  const name = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name === "" || name === "brainz") return "brainz-demos";
  return name.startsWith("brainz-") ? name : `brainz-demos-${name}`;
};

/** A port in 8800–8899 from the project name (`BRAINZ_DEMOS_PORT` overrides). */
export const stackPort = (project = projectName()): number => {
  const fromEnv = Number(process.env.BRAINZ_DEMOS_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  let hash = 0;
  for (const char of project) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 8800 + (hash % 100);
};

/** Where the browser and the seed reach the app: `localhost`, since Better Auth trusts the origin it was told. */
export const origin = (port = stackPort()): string => `http://localhost:${port}`;

/**
 * The CPUs this process may run on (`taskset`/`mheavy` set them), as a
 * cpuset list — handed to compose so the container keeps to the job's
 * block too (docker does not inherit a client's affinity).
 */
export const allowedCpus = (status = readProcStatus()): string | undefined =>
  /^Cpus_allowed_list:\s*(\S+)/m.exec(status)?.[1];

const readProcStatus = (): string => {
  try {
    return readFileSync("/proc/self/status", "utf8");
  } catch {
    return "";
  }
};

const composeEnv = (): NodeJS.ProcessEnv => {
  const cpus = process.env.DEMOS_CPUS ?? allowedCpus();
  return {
    ...process.env,
    BRAINZ_DEMOS_PORT: String(stackPort()),
    BRAINZ_DEMOS_UID: String(process.getuid?.() ?? 1000),
    BRAINZ_DEMOS_GID: String(process.getgid?.() ?? 1000),
    ...(cpus === undefined ? {} : { BRAINZ_DEMOS_CPUS: cpus }),
  };
};

const compose = (...args: string[]): string =>
  execFileSync("docker", ["compose", "-p", projectName(), "-f", join(root, "compose.yaml"), ...args], {
    cwd: root,
    env: composeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** The worker wrangler serves: built by `npm run build` (vite + patch-worker), never by hand. */
export const builtWorker = join(root, "apps/cloud/.svelte-kit/cloudflare/_worker.js");

/**
 * Build what the stack serves from the working tree, so a clip shows the
 * screens its fingerprint names: engine and contracts (the seed parses
 * notes with engine) and the cloud app.
 */
export const build = (say: (line: string) => void): void => {
  say("demos: building engine, contracts and the cloud app…");
  const run = spawnSync(
    "npm",
    ["run", "build", "-w", "@brainz/engine", "-w", "@brainz/contracts", "-w", "@brainz/cloud"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (run.status !== 0) throw new Error(`the build failed (exit ${run.status})`);
};

/** Whether the app answers at all. */
export const reachable = async (at = origin()): Promise<boolean> => {
  try {
    const response = await fetch(`${at}/login`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
};

/** Bring up a fresh stack (a running one is taken down first, so its state goes) and wait until it answers. */
export const up = async (say: (line: string) => void): Promise<void> => {
  if (!existsSync(builtWorker)) throw new Error(`${builtWorker} is missing: build the cloud app first`);
  down();
  say(`demos: starting ${projectName()} on ${origin()}…`);
  compose("up", "-d", "cloud");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the stack did not answer at ${origin()} within 120s:\n${logs().slice(-2000)}`);
};

/** Take the stack down; its state was on a tmpfs, so it is gone. */
export const down = (): void => {
  compose("down", "--remove-orphans", "--timeout", "5");
};

/** Everything the cloud service has logged: where the mailer stub wrote each email among it. */
export const logs = (): string => compose("logs", "--no-color", "--no-log-prefix", "cloud");

/** A file inside the cloud container (an email the mailer stub wrote under its /tmp). */
export const readInStack = (path: string): string => compose("exec", "-T", "cloud", "cat", path);
