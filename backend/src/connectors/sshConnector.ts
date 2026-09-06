import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(exec);

/**
 * SSH Connector — how HERA reads a machine.
 *
 * SAFETY CORE: every command HERA can run lives in READ_ONLY_COMMANDS below.
 * There is no code path that runs anything else. HERA can look, never touch.
 * Actions (restart/create/delete) are a future episode and will be
 * approval-gated separately.
 */

// ── the allowlist. if it isn't here, HERA cannot run it. ────────────────────
export const READ_ONLY_COMMANDS = {
  hostname: "hostname",
  uptime: "uptime -p 2>/dev/null || uptime",
  disk: "df -h --output=source,size,used,avail,pcent 2>/dev/null | grep -vE 'tmpfs|overlay|udev|efivarfs|squashfs|/dev/loop' | tail -n +2",
  memory: "free -m 2>/dev/null | awk '/^Mem:/{print $2\" \"$3}'",
  load: "cat /proc/loadavg 2>/dev/null | awk '{print $1}'",
  docker: "D=$(command -v docker || ls /Volume1/@apps/DockerEngine/dockerd/bin/docker /usr/local/bin/docker 2>/dev/null | head -1); [ -n \"$D\" ] && $D ps --format '{{.Names}}|{{.Status}}' 2>/dev/null || true",
} as const;

export interface HostConfig {
  id: string;
  name: string;          // friendly label, e.g. "Ubuntu / 3090"
  user: string;          // ssh user
  address: string;       // ip or hostname
  port: number;          // ssh port (22 default, 9222 for the NAS etc.)
  keyPath: string;       // path to HERA's private key on the HERA host
  isLocal: boolean;      // true for the machine HERA itself runs on
  enabled: boolean;
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
  error?: string;
  readAt: string;
}

/** Build the single batched command — one SSH round trip per host. */
function buildProbe(): string {
  const c = READ_ONLY_COMMANDS;
  return [
    c.hostname,
    "echo '@@'",
    c.uptime,
    "echo '@@'",
    c.disk,
    "echo '@@'",
    c.memory,
    "echo '@@'",
    c.load,
    "echo '@@'",
    c.docker,
  ].join("; ");
}

function parseDisks(block: string): DiskInfo[] {
  const seen = new Set<string>();
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [filesystem, size, used, available, pcent] = line.split(/\s+/);
      return {
        filesystem,
        size,
        used,
        available,
        usedPercent: parseInt((pcent || "0").replace("%", ""), 10) || 0,
      };
    })
    .filter((d) => {
      // same filesystem can be mounted at many paths — show it once
      if (!d.filesystem || !d.size) return false;
      if (seen.has(d.filesystem)) return false;
      seen.add(d.filesystem);
      return true;
    });
}

function parseContainers(block: string): ContainerInfo[] {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, status] = line.split("|");
      return { name, status: status || "unknown" };
    })
    .filter((c) => c.name);
}

/**
 * Read one host. Uses local shell if it's HERA's own machine,
 * otherwise SSH with HERA's dedicated key.
 */
export async function readHost(host: HostConfig): Promise<HostState> {
  const base: HostState = {
    id: host.id,
    name: host.name,
    reachable: false,
    disks: [],
    containers: [],
    readAt: new Date().toISOString(),
  };

  const probe = buildProbe();
  const quotedProbe = "'" + probe.replace(/'/g, "'\\''") + "'";
  const command = host.isLocal
    ? probe
    : `ssh -i ${host.keyPath} -p ${host.port} ` +
      `-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new ` +
      `${host.user}@${host.address} ${quotedProbe}`;

  try {
    const { stdout } = await run(command, { timeout: 15000, maxBuffer: 1024 * 1024 });
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
    return {
      ...base,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

/** Read every enabled host in parallel — one slow box doesn't block the rest. */
export async function readAllHosts(hosts: HostConfig[]): Promise<HostState[]> {
  return Promise.all(hosts.filter((h) => h.enabled).map(readHost));
}

/** Sensible default for the machine HERA is running on. */
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
  };
}
