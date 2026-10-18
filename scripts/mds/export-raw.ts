import { writeFileSync } from "node:fs";
import { loadParticipants } from "./participants";

const [db, out] = process.argv.slice(2);
writeFileSync(out, JSON.stringify(loadParticipants(db)));
