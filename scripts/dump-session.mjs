import fs from "node:fs";
const file = process.argv[2];
if (!file) {
  console.error("usage: node dump-tools.mjs <session.jsonl>");
  process.exit(1);
}
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    if (e.type !== "message") continue;
    const role = e.message?.role;
    if (role === "toolResult") {
      const t = (e.message.content ?? [])
        .map((c) => c.text ?? "")
        .join("\n");
      if (/web|tool/i.test(t)) {
        console.log("--- toolResult (" + e.message.toolName + ") ---");
        console.log(t.slice(0, 1500));
      }
    }
    if (role === "assistant") {
      for (const c of e.message.content ?? []) {
        if (c.type === "text" && /web_search|web_fetch|yield/i.test(c.text)) {
          console.log("--- assistant text ---");
          console.log(c.text.slice(0, 1500));
        }
      }
    }
  } catch {
    /* skip */
  }
}
