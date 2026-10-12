import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(exec);

/**
 * SSH Connector — how HERA reads (and, since Episode 3, acts on) a machine.
 *
 * SAFETY CORE:
 *  - Reads: only the commands in READ_ONLY_COMMANDS can run.
 *  - Actions: only the verbs in DOCKER_ACTIONS, on a validated container name,
 *    built from fixed parts. The AI never supplies a command — only parameters
 *    that are validated against real state before anything is built.
 */

// docker lives in odd places on NAS OSes (TerraMaster TOS installs it under
// /Volume1/@apps) — resolve the binary before using it.
const DOCKER_RESOLVE =
  "D=$(command -v docker || ls /Volume1/@apps/DockerEngine/dockerd/bin/docker /usr/local/bin/docker 2>/dev/null | head -1)";

// ── the read allowlist. if it isn't here, HERA cannot run it. ───────────────
export const READ_ONLY_COMMANDS = {
  hostname: "hostname",
  uptime: "uptime -p 2>/dev/null || uptime",
  disk: "df -h --output=source,size,used,avail,pcent 2>/dev/null | grep -vE 'tmpfs|overlay|udev|efivarfs|squashfs|/dev/loop' | tail -n +2",
  memory: "free -m 2>/dev/null | awk '/^Mem:/{print $2\" \"$3}'",
  load: "cat /proc/loadavg 2>/dev/null | awk '{print $1}'",
  // ps -a: stopped containers matter — they're what the start action fixes
  docker: `${DOCKER_RESOLVE}; [ -n "$D" ] && $D ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null || true`,
} as const;

// ── the action allowlist (Episode 3) ────────────────────────────────────────
export const DOCKER_ACTIONS = ["start", "stop", "restart"] as const;
export type DockerAction = (typeof DOCKER_ACTIONS)[number];

/** container names: docker's own charset — reject anything else outright */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface HostConfig {
  id: string;
  name: string;
  user: string;
  address: string;
  port: number;
  keyPath: string;
  isLocal: boolean;
  enabled: boolean;
  /** readonly = observe only · guarded = actions w/ approval · sandbox = test host */
  policy?: "readonly" | "guarded" | "sandbox";
}

export interface DiskInfo {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usedPercent: number;
}

export interface ContainerInfo {
  name: string;
  status: string;
  running: boolean;
}

export interface HostState {
  id: string;
  name: string;
  reachable: boolean;
  hostname?: string;
  uptime?: string;
  loadAvg?: number;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
  disks: DiskInfo[];
  containers: ContainerInfo[];
  policy: string;
  error?: string;
  readAt: string;
}

/** Wrap a command for a host: run locally on HERA's own machine, else SSH.
 *  Single-quoted for the remote so $vars expand THERE, not on HERA's host. */
function hostCommand(host: HostConfig, cmd: string): string {
  if (host.isLocal) return cmd;
  const quoted = "'" + cmd.replace(/'/g, "'\\''") + "'";
  return (
    `ssh -i ${host.keyPath} -p ${host.port} ` +
    `-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new ` +
    `${host.user}@${host.address} ${quoted}`
  );
}

function buildProbe(): string {
  const c = READ_ONLY_COMMANDS;
  return [
    c.hostname, "echo '@@'",
    c.uptime, "echo '@@'",
    c.disk, "echo '@@'",
    c.memory, "echo '@@'",
    c.load, "echo '@@'",
    c.docker,
  ].join("; ");
}

function parseDisks(block: string): DiskInfo[] {
  const seen = new Set<string>();
  return block
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const [filesystem, size, used, available, pcent] = line.split(/\s+/);
      return {
        filesystem, size, used, available,
        usedPercent: parseInt((pcent || "0").replace("%", ""), 10) || 0,
      };
    })
    .filter((d) => {
      if (!d.filesystem || !d.size) return false;
      if (seen.has(d.filesystem)) return false;
      seen.add(d.filesystem);
      return true;
    });
}

function parseContainers(block: string): ContainerInfo[] {
  return block
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const [name, status] = line.split("|");
      return { name, status: status || "unknown", running: (status || "").startsWith("Up") };
    })
    .filter((c) => c.name);
}

export async function readHost(host: HostConfig): Promise<HostState> {
  const base: HostState = {
    id: host.id, name: host.name, reachable: false,
    disks: [], containers: [],
    policy: host.policy || "guarded",
    readAt: new Date().toISOString(),
  };

  try {
    const { stdout } = await run(hostCommand(host, buildProbe()), {
      timeout: 15000, maxBuffer: 1024 * 1024,
    });
    const [hostname, uptime, disk, memory, load, docker] = stdout.split("@@").map((s) => s.trim());
    const [memTotal, memUsed] = (memory || "").split(/\s+/).map((n) => parseInt(n, 10));

    return {
      ...base,
      reachable: true,
      hostname: hostname || undefined,
      uptime: uptime || undefined,
      loadAvg: parseFloat(load) || undefined,
      memoryTotalMb: Number.isFinite(memTotal) ? memTotal : undefined,
      memoryUsedMb: Number.isFinite(memUsed) ? memUsed : undefined,
      disks: parseDisks(disk || ""),
      containers: parseContainers(docker || ""),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

export async function readAllHosts(hosts: HostConfig[]): Promise<HostState[]> {
  return Promise.all(hosts.filter((h) => h.enabled).map(readHost));
}

/**
 * Execute an approved docker action. Called ONLY by the action engine after
 * operator approval. Everything here is built from validated, fixed parts.
 */
export async function runDockerAction(
  host: HostConfig,
  action: DockerAction,
  container: string
): Promise<string> {
  if (!DOCKER_ACTIONS.includes(action)) throw new Error(`Action not allowed: ${action}`);
  if (!SAFE_NAME.test(container)) throw new Error(`Invalid container name: ${container}`);

  const cmd = `${DOCKER_RESOLVE}; [ -n "$D" ] && $D ${action} '${container}' 2>&1 || echo 'docker not found on host'`;
  const { stdout } = await run(hostCommand(host, cmd), { timeout: 30000, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** Read-only: recent logs for a container. No approval needed. */
export async function getContainerLogs(
  host: HostConfig,
  container: string,
  lines = 40
): Promise<string> {
  if (!SAFE_NAME.test(container)) throw new Error(`Invalid container name: ${container}`);
  const n = Math.min(Math.max(lines, 5), 200);
  const cmd = `${DOCKER_RESOLVE}; [ -n "$D" ] && $D logs --tail ${n} '${container}' 2>&1 | tail -${n} || echo 'docker not found on host'`;
  const { stdout } = await run(hostCommand(host, cmd), { timeout: 20000, maxBuffer: 1024 * 1024 });
  return stdout;
}

export function localHostDefault(): HostConfig {
  return {
    id: "hera-host",
    name: `${os.hostname()} (HERA host)`,
    user: os.userInfo().username,
    address: "localhost",
    port: 22,
    keyPath: `${os.homedir()}/.ssh/hera_key`,
    isLocal: true,
    enabled: true,
    policy: "guarded",
  };
}
