import { writeFileSync } from "node:fs";
import { loadParticipants } from "./participants";
const [db, out] = process.argv.slice(2);
const r = loadParticipants(db);
writeFileSync(out, r.statements.map((s, i) => `S${String(i + 1).padStart(2, "0")}\t${s.text}\t${s.textJa ?? ""}\t${s.jaStatus}`).join("\n"), "utf8");
