import { mkdir, appendFile, writeFile, access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = "/var/log/sessions";

export default async () => {
  await mkdir(LOG_DIR, { recursive: true });

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (part.type === "text") {
          pending.set(`${part.sessionID}:${part.messageID}`, part.text);
        }
        return;
      }

      if (event.type !== "message.updated") return;

      const info = event.properties.info;
      const sessionID = info.sessionID;
      const messageID = info.id;
      const dedupeKey = `${sessionID}:${messageID}`;

      if (persisted.has(dedupeKey)) return;
      if (info.role === "assistant" && !info.time?.completed) return;

      const text = pending.get(dedupeKey) || info.text;
      if (!text) return;

      let session = sessions.get(sessionID);
      if (!session) {
        // Not in memory: either a new session or a plugin restart. Look on disk
        // for an existing dir so the timestamp prefix stays stable, and seed the
        // dedupe set from its jsonl so appends remain idempotent across restarts.
        session = await resumeSession(sessionID);
        if (!session) {
          const dirTimestamp = fmtTs(new Date());
          const dirPath = join(LOG_DIR, `${dirTimestamp}_${sessionID}`);
          session = { dirTimestamp, dirPath };
        }
        sessions.set(sessionID, session);
      }

      // Re-check after a possible disk reseed: this message may already be logged.
      if (persisted.has(dedupeKey)) return;

      await mkdir(session.dirPath, { recursive: true });
      await ensureMeta(session, sessionID);

      const iso = new Date().toISOString();

      if (info.role === "user") {
        const entry = {
          ts: iso,
          sessionID,
          messageID,
          role: "user",
          textPath: "user.md",
          text,
        };
        await appendFile(join(session.dirPath, "messages.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
        await appendFile(
          join(session.dirPath, "user.md"),
          `# User message\n<!-- ts=${iso} messageID=${messageID} -->\n\n${text}\n\n`,
          "utf-8",
        );
      } else {
        await mkdir(join(session.dirPath, "assistant"), { recursive: true });
        const assistantPath = `assistant/${messageID}.md`;
        await writeFile(join(session.dirPath, assistantPath), text, "utf-8");
        const entry = {
          ts: iso,
          sessionID,
          messageID,
          role: "assistant",
          textPath: assistantPath,
          ...(info.modelID ? { modelID: info.modelID } : {}),
          ...(info.providerID ? { providerID: info.providerID } : {}),
        };
        await appendFile(join(session.dirPath, "messages.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
      }

      persisted.add(dedupeKey);
      pending.delete(dedupeKey);
    },
  };
};

async function resumeSession(
  sessionID: string,
): Promise<{ dirTimestamp: string; dirPath: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    return null;
  }
  const suffix = `_${sessionID}`;
  const dirName = entries.find((e) => e.endsWith(suffix));
  if (!dirName) return null;

  const dirPath = join(LOG_DIR, dirName);
  const dirTimestamp = dirName.slice(0, -suffix.length);

  // Seed dedupe from the existing jsonl so we don't re-append known messages.
  try {
    const jsonl = await readFile(join(dirPath, "messages.jsonl"), "utf-8");
    for (const line of jsonl.split("\n")) {
      if (!line) continue;
      try {
        const { messageID } = JSON.parse(line);
        if (messageID) persisted.add(`${sessionID}:${messageID}`);
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // no jsonl yet; nothing to seed
  }

  return { dirTimestamp, dirPath };
}

function fmtTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function ensureMeta(session: { dirTimestamp: string; dirPath: string }, sessionID: string): Promise<void> {
  const metaPath = join(session.dirPath, "meta.json");
  try {
    await access(metaPath);
  } catch {
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          sessionID,
          createdAt: new Date().toISOString(),
          dirTimestamp: session.dirTimestamp,
          logVersion: 1,
          cwd: process.cwd(),
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }
}

const sessions = new Map<string, { dirTimestamp: string; dirPath: string }>();
const pending = new Map<string, string>();
const persisted = new Set<string>();
