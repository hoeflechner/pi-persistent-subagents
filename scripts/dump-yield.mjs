import fs from "node:fs";
const file = process.argv[2];
if (!file) {
  console.error("usage: node dump-yield.mjs <session.jsonl>");
  process.exit(1);
}
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
for (const l of lines) {
  let e;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  if (e.type !== "message") continue;
  const m = e.message;
  if (m.role === "assistant") {
    for (const c of m.content ?? []) {
      if (c.type === "toolCall" && c.name === "yield_to_caller") {
        console.log("[YIELD ARGS]", JSON.stringify(c.arguments).slice(0, 3000));
      }
      if (c.type === "text") {
        console.log("[TEXT]", c.text.slice(0, 2000));
      }
    }
  }
}
