import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Conversation Store — HERA's chat memory.
 * Conversations live on the backend (data/conversations.json), so they
 * survive restarts and are the same from every device. Approval cards
 * reference actions by id, so a pending approval survives a page refresh.
 */

export interface StoredMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  ts: string;
  /** set when this assistant message carries an approval card */
  pendingActionId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

const DATA_DIR = process.env.HERA_DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "conversations.json");

let cache: Conversation[] | null = null;

async function load(): Promise<Conversation[]> {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(await readFile(FILE, "utf-8")) : [];
  } catch {
    cache = [];
  }
  return cache!;
}

async function save(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export async function listConversations(): Promise<
  { id: string; title: string; updatedAt: string; count: number }[]
> {
  const all = await load();
  return all
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createConversation(): Promise<Conversation> {
  const all = await load();
  const convo: Conversation = {
    id: crypto.randomUUID().slice(0, 8),
    title: "New conversation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  all.push(convo);
  await save();
  return convo;
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const all = await load();
  return all.find((c) => c.id === id);
}

export async function appendMessage(
  id: string,
  msg: Omit<StoredMessage, "ts">
): Promise<Conversation> {
  const all = await load();
  const convo = all.find((c) => c.id === id);
  if (!convo) throw new Error(`No conversation ${id}`);
  convo.messages.push({ ...msg, ts: new Date().toISOString() });
  convo.updatedAt = new Date().toISOString();
  // title = first user message, truncated
  if (convo.title === "New conversation" && msg.role === "user") {
    convo.title = msg.content.slice(0, 48) + (msg.content.length > 48 ? "…" : "");
  }
  await save();
  return convo;
}

export async function deleteConversation(id: string): Promise<void> {
  const all = await load();
  const i = all.findIndex((c) => c.id === id);
  if (i >= 0) {
    all.splice(i, 1);
    await save();
  }
}
