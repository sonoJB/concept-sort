#!/usr/bin/env node
/**
 * Encrypts / decrypts a backup package (e.g. the .zip) with AES-256-GCM using
 * only Node's built-in crypto. The package contains personal data and the
 * admin token, so anything stored outside a trusted machine should be the
 * ENCRYPTED file; the key must be kept somewhere else (password manager,
 * offline medium) — never next to the encrypted file.
 *
 *   node scripts/backup/crypt.mjs encrypt --in a.zip --out a.zip.enc --key-file ./backup.key [--make-key]
 *   node scripts/backup/crypt.mjs decrypt --in a.zip.enc --out a.zip  --key-file ./backup.key
 *
 *   Passphrase instead of a key file (typed at a hidden prompt, scrypt-derived):
 *   node scripts/backup/crypt.mjs encrypt --in a.zip --out a.zip.enc --passphrase
 *
 * The key (file content) is NEVER printed. `--make-key` creates a new random
 * 256-bit key file (mode 0600) and refuses to overwrite an existing one.
 *
 * File format: "CSBK" | version(1) | mode(1: key-file, 2: passphrase) |
 *              [scrypt salt(16) if mode 2] | nonce(12) | ciphertext | GCM tag(16)
 * The header is authenticated (AAD), so tampering with any byte is detected.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("CSBK");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function keyFromFile(file) {
  const hex = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("key file must contain 64 hex characters (a 256-bit key)");
  return Buffer.from(hex, "hex");
}

export function makeKeyFile(file) {
  if (fs.existsSync(file)) throw new Error("refusing to overwrite an existing key file");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
}

export function encryptBuffer(plain, { key, passphrase }) {
  const nonce = crypto.randomBytes(12);
  let header;
  let k = key;
  if (passphrase !== undefined) {
    const salt = crypto.randomBytes(16);
    k = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
    header = Buffer.concat([MAGIC, Buffer.from([1, 2]), salt, nonce]);
  } else {
    header = Buffer.concat([MAGIC, Buffer.from([1, 1]), nonce]);
  }
  const cipher = crypto.createCipheriv("aes-256-gcm", k, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export function decryptBuffer(enc, { key, passphrase }) {
  if (enc.length < 4 + 2 + 12 + 16 || !enc.subarray(0, 4).equals(MAGIC) || enc[4] !== 1) throw new Error("not a CSBK v1 file");
  const mode = enc[5];
  let off = 6;
  let k = key;
  if (mode === 2) {
    if (passphrase === undefined) throw new Error("this file was encrypted with a passphrase");
    const salt = enc.subarray(off, off + 16);
    off += 16;
    k = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  } else if (mode !== 1) {
    throw new Error("unknown mode");
  } else if (!key) {
    throw new Error("this file was encrypted with a key file");
  }
  const nonce = enc.subarray(off, off + 12);
  const header = enc.subarray(0, off + 12);
  const tag = enc.subarray(enc.length - 16);
  const body = enc.subarray(off + 12, enc.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", k, nonce);
  d.setAAD(header);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new Error("decryption failed: wrong key/passphrase or the file was modified");
  }
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("a hidden passphrase prompt needs an interactive terminal"));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  if (!["encrypt", "decrypt"].includes(cmd) || !opt.in || !opt.out) {
    console.error("usage: crypt.mjs encrypt|decrypt --in <file> --out <file> (--key-file <file> [--make-key] | --passphrase)");
    process.exit(2);
  }
  if (fs.existsSync(opt.out)) throw new Error("refusing to overwrite existing output file");
  let secret;
  if (opt.passphrase) {
    const p1 = await askHidden("Passphrase: ");
    if (cmd === "encrypt") {
      const p2 = await askHidden("Repeat passphrase: ");
      if (p1 !== p2) throw new Error("passphrases differ");
    }
    if (p1.length < 12) throw new Error("use a passphrase of at least 12 characters");
    secret = { passphrase: p1 };
  } else {
    if (!opt["key-file"]) throw new Error("--key-file or --passphrase is required");
    if (opt["make-key"] && cmd === "encrypt") makeKeyFile(opt["key-file"]);
    secret = { key: keyFromFile(opt["key-file"]) };
  }
  const input = fs.readFileSync(opt.in);
  const output = cmd === "encrypt" ? encryptBuffer(input, secret) : decryptBuffer(input, secret);
  fs.writeFileSync(opt.out, output, { flag: "wx" });
  console.log(`${cmd}ed ${input.length} -> ${output.length} bytes (sha256 of output: ${crypto.createHash("sha256").update(output).digest("hex")})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[crypt] FAILED:", e.message);
    process.exit(1);
  });
}
