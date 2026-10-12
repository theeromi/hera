import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Memory Store — HERA's long-term memory and skills.
 *
 * memory/HERA.md  — always loaded into the system prompt. Facts, rules and
 *                   preferences the operator wants HERA to always know.
 *                   Editable from Settings. Human-readable on purpose.
 *
 * skills/*.md     — teachable skills. Each file teaches HERA how to handle
 *                   one domain (docker.md is the first). Loaded into context
 *                   so the model knows what it may do and when it must ask.
 */

const DATA_DIR = process.env.HERA_DATA_DIR || path.resolve("data");
const MEMORY_DIR = path.join(DATA_DIR, "memory");
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const MEMORY_FILE = path.join(MEMORY_DIR, "HERA.md");

const DEFAULT_MEMORY = `# HERA memory

## Operator
- The operator runs this homelab and approves all actions.

## Standing rules
- Never propose actions on hosts marked read-only.
- If a request is ambiguous or could be destructive, ask before proposing.
- Prefer the sandbox host for anything experimental.
`;

const DEFAULT_DOCKER_SKILL = `# Skill: Docker container management

You can manage Docker containers on the homelab hosts, within strict limits.

## What you can do
- restart, start, or stop a container — by PROPOSING the action with the
  propose_action tool. You never execute anything yourself. The operator
  sees the proposal and approves or denies it.
- fetch recent logs for a container with get_container_logs (read-only,
  runs immediately, no approval needed).

## Rules
- Only propose actions on containers that actually exist in the homelab
  state you can see. Never guess container names.
- Hosts marked READ-ONLY must never receive proposals.
- One proposal at a time. Wait for the operator's decision.
- When a container is unhealthy or exited, check its logs first when that
  would help explain the problem, then propose the fix.
- Always include a short reason with a proposal.
`;

async function ensureDefaults(): Promise<void> {
  if (!existsSync(MEMORY_DIR)) await mkdir(MEMORY_DIR, { recursive: true });
  if (!existsSync(SKILLS_DIR)) await mkdir(SKILLS_DIR, { recursive: true });
  if (!existsSync(MEMORY_FILE)) await writeFile(MEMORY_FILE, DEFAULT_MEMORY, "utf-8");
  const dockerSkill = path.join(SKILLS_DIR, "docker.md");
  if (!existsSync(dockerSkill)) await writeFile(dockerSkill, DEFAULT_DOCKER_SKILL, "utf-8");
}

export async function getMemory(): Promise<string> {
  await ensureDefaults();
  return readFile(MEMORY_FILE, "utf-8");
}

export async function saveMemory(content: string): Promise<void> {
  await ensureDefaults();
  await writeFile(MEMORY_FILE, content, "utf-8");
}

/** All skills concatenated (they are small, and one skill exists today). */
export async function getSkills(): Promise<string> {
  await ensureDefaults();
  const files = (await readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md")).sort();
  const parts: string[] = [];
  for (const f of files) {
    parts.push(await readFile(path.join(SKILLS_DIR, f), "utf-8"));
  }
  return parts.join("\n\n");
}
