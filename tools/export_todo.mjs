// Pulls the recipe and grocery lists out of Microsoft To Do into
// migration/export/, with checklist steps and photo attachments.
//
// It borrows the sign-in of the mstodo MCP server, so it needs no login of its
// own. Reading only: nothing in To Do is changed.
//
//     node tools/export_todo.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "migration", "export");
const MSTODO = process.env.MSTODO_DIR
  ?? "C:/path/to/the/workspace/Custom MCPs/mstodo-mcp";

const { getLists } = await import(pathToFileURL(path.join(MSTODO, "dist", "todo.js")).href);
const { graphCollect, graphRequest } = await import(pathToFileURL(path.join(MSTODO, "dist", "graph.js")).href);

// Exact names. There is also an old list called just "Boodschappen"
// (2019–2024); matching on "Boodschappen" picked that one and imported the
// wrong list (28-10-2026).
const WANTED = { recipes: "🍽 Recepten", groceries: "🛒 Boodschappen" };
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

await fs.mkdir(path.join(OUT, "photos"), { recursive: true });
const lists = await getLists(true);
const result = { exported_at: new Date().toISOString(), lists: {} };

for (const [key, needle] of Object.entries(WANTED)) {
  const list = lists.find((l) => l.displayName.trim() === needle);
  if (!list) throw new Error(`No To Do list named "${needle}"`);
  const base = `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`;
  const tasks = await graphCollect(`${base}?$expand=checklistItems&$top=100`, 50000);

  for (const task of tasks) {
    task.photos = [];
    if (!task.hasAttachments) continue;
    const attachments = await graphCollect(`${base}/${encodeURIComponent(task.id)}/attachments`, 50);
    for (const [i, att] of attachments.entries()) {
      const full = await graphRequest(`${base}/${encodeURIComponent(task.id)}/attachments/${encodeURIComponent(att.id)}`);
      if (!full?.contentBytes) continue;
      const ext = EXT[full.contentType] ?? path.extname(full.name ?? "") ?? ".bin";
      const file = `${key}-${task.id.slice(-12)}-${i}${ext}`.replace(/[^\w.-]/g, "_");
      await fs.writeFile(path.join(OUT, "photos", file), Buffer.from(full.contentBytes, "base64"));
      task.photos.push({ file, name: full.name, contentType: full.contentType });
    }
  }
  result.lists[key] = { id: list.id, name: list.displayName, tasks };
  console.log(`${list.displayName}: ${tasks.length} tasks, ${tasks.filter((t) => t.photos.length).length} with photos`);
}

await fs.writeFile(path.join(OUT, "export.json"), JSON.stringify(result, null, 2));
console.log(`Written to ${path.relative(ROOT, OUT)}`);
