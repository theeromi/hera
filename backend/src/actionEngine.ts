import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getHomelabState, loadHosts } from "./connectors/hostRegistry.js";
import { runDockerAction, DOCKER_ACTIONS, type DockerAction } from "./connectors/sshConnector.js";

/**
 * Action Engine — HERA's hands, with the safety model as code:
 *
 *   AI PROPOSES  →  HUMAN APPROVES  →  DETERMINISTIC CODE EXECUTES
 *
 * The AI can only create a *proposal*. Nothing runs until the operator
 * approves it in the console. Every parameter is validated against the
 * cached homelab state before a proposal is even created, and again the
 * per-host policy is enforced:
 *
 *   readonly → HERA may look, never act (proposals refused outright)
 *   guarded  → actions allowed, every one requires approval
 *   sandbox  → same as guarded today; wider action set in later episodes
 */

export interface PendingAction {
  id: string;
  hostId: string;
  hostName: string;
  container: string;
  action: DockerAction;
  reason: string;
  status: "pending" | "approved" | "denied" | "executed" | "failed";
  createdAt: string;
  resolvedAt?: string;
  result?: string;
}

const DATA_DIR = process.env.HERA_DATA_DIR || path.resolve("data");
const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");

let actions: PendingAction[] | null = null;

async function load(): Promise<PendingAction[]> {
  if (actions) return actions;
  try {
    actions = existsSync(ACTIONS_FILE)
      ? JSON.parse(await readFile(ACTIONS_FILE, "utf-8"))
      : [];
  } catch {
    actions = [];
  }
  return actions!;
}

async function save(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ACTIONS_FILE, JSON.stringify(actions, null, 2), "utf-8");
}

/**
 * Validate + create a proposal. Throws with a human-readable reason if the
 * proposal is not allowed — that reason goes back to the AI so it can explain.
 */
export async function proposeAction(
  hostId: string,
  container: string,
  action: string,
  reason: string
): Promise<PendingAction> {
  // 1. action must be on the allowlist
  if (!DOCKER_ACTIONS.includes(action as DockerAction)) {
    throw new Error(`Action "${action}" is not allowed. Allowed: ${DOCKER_ACTIONS.join(", ")}.`);
  }

  // 2. host must exist and be enabled
  const hosts = await loadHosts();
  const host = hosts.find((h) => h.id === hostId && h.enabled);
  if (!host) {
    throw new Error(`Unknown host "${hostId}". Known hosts: ${hosts.map((h) => h.id).join(", ")}.`);
  }

  // 3. policy gate — readonly hosts refuse before anything else
  const policy = host.policy || "guarded";
  if (policy === "readonly") {
    throw new Error(
      `Host "${host.name}" is READ-ONLY by policy. HERA can observe it but never act on it.`
    );
  }

  // 4. container must actually exist on that host (validated against real state)
  let { hosts: states } = await getHomelabState();
  let state = states.find((s) => s.id === hostId);
  let known = state?.containers.find((c) => c.name === container);
  if (!known) {
    // one forced refresh in case the cache is stale
    ({ hosts: states } = await getHomelabState(true));
    state = states.find((s) => s.id === hostId);
    known = state?.containers.find((c) => c.name === container);
  }
  if (!known) {
    const names = state?.containers.map((c) => c.name).join(", ") || "none found";
    throw new Error(
      `Container "${container}" does not exist on ${host.name}. Containers there: ${names}.`
    );
  }

  const pending: PendingAction = {
    id: crypto.randomUUID().slice(0, 8),
    hostId,
    hostName: host.name,
    container,
    action: action as DockerAction,
    reason: reason || "",
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  await load();
  actions!.push(pending);
  await save();
  return pending;
}

/** Operator approved — NOW it executes, via deterministic allowlisted code. */
export async function approveAction(id: string): Promise<PendingAction> {
  await load();
  const a = actions!.find((x) => x.id === id);
  if (!a) throw new Error(`No action with id ${id}`);
  if (a.status !== "pending") throw new Error(`Action ${id} is already ${a.status}`);

  const hosts = await loadHosts();
  const host = hosts.find((h) => h.id === a.hostId && h.enabled);
  if (!host) throw new Error(`Host ${a.hostId} is no longer configured or enabled`);
  if ((host.policy || "guarded") === "readonly") {
    throw new Error(`Host "${host.name}" is READ-ONLY by policy. HERA can observe it but never act on it.`);
  }

  const { hosts: states } = await getHomelabState(true);
  const state = states.find((item) => item.id === a.hostId);
  if (!state?.containers.some((container) => container.name === a.container)) {
    throw new Error(`Container "${a.container}" is no longer present on ${host.name}`);
  }

  a.status = "approved";
  try {
    const output = await runDockerAction(host, a.action, a.container);
    a.status = "executed";
    a.result = output.trim().slice(0, 500);
  } catch (err) {
    a.status = "failed";
    a.result = err instanceof Error ? err.message.slice(0, 500) : String(err);
  }
  a.resolvedAt = new Date().toISOString();
  await save();

  // state just changed — force the next homelab read to be fresh
  await getHomelabState(true).catch(() => {});
  return a;
}

export async function denyAction(id: string): Promise<PendingAction> {
  await load();
  const a = actions!.find((x) => x.id === id);
  if (!a) throw new Error(`No action with id ${id}`);
  if (a.status !== "pending") throw new Error(`Action ${id} is already ${a.status}`);
  a.status = "denied";
  a.resolvedAt = new Date().toISOString();
  await save();
  return a;
}

export async function listActions(status?: string): Promise<PendingAction[]> {
  await load();
  return status ? actions!.filter((a) => a.status === status) : [...actions!];
}

export async function getAction(id: string): Promise<PendingAction | undefined> {
  await load();
  return actions!.find((a) => a.id === id);
}
