import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
// @ts-expect-error plain-JS Node script (no type declarations)
import { encryptBuffer, decryptBuffer, makeKeyFile } from "../../scripts/backup/crypt.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "concept-sort-crypt-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("crypt.mjs (AES-256-GCM backup package encryption)", () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from("PII: 홍길동 010-1234-5678 / adminToken=secret-token\n".repeat(50));

  it("round-trips and the ciphertext does not contain the plaintext", () => {
    const enc = encryptBuffer(plain, { key });
    expect(enc.includes("010-1234-5678")).toBe(false);
    expect(enc.includes("secret-token")).toBe(false);
    expect(decryptBuffer(enc, { key }).equals(plain)).toBe(true);
  });

  it("wrong key and any tampering are detected", () => {
    const enc = encryptBuffer(plain, { key });
    expect(() => decryptBuffer(enc, { key: crypto.randomBytes(32) })).toThrow(/decryption failed/);
    for (const pos of [2, 5, 10, 40, enc.length - 1]) {
      const bad = Buffer.from(enc);
      bad[pos] ^= 1;
      expect(() => decryptBuffer(bad, { key })).toThrow();
    }
  });

  it("each encryption uses a fresh nonce", () => {
    expect(encryptBuffer(plain, { key }).equals(encryptBuffer(plain, { key }))).toBe(false);
  });

  it("passphrase mode round-trips and rejects a wrong passphrase", () => {
    const enc = encryptBuffer(plain, { passphrase: "correct horse battery" });
    expect(decryptBuffer(enc, { passphrase: "correct horse battery" }).equals(plain)).toBe(true);
    expect(() => decryptBuffer(enc, { passphrase: "wrong horse battery!" })).toThrow();
    expect(() => decryptBuffer(enc, { key })).toThrow();
  });

  it("CLI: creates a key file once (never printed, never overwritten), encrypts, decrypts, byte-identical", () => {
    const script = path.resolve(process.cwd(), "scripts/backup/crypt.mjs");
    const input = path.join(root, "in.bin");
    fs.writeFileSync(input, plain);
    const keyFile = path.join(root, "k", "backup.key");
    const run = (...a: string[]) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8" });

    const e = run("encrypt", "--in", input, "--out", path.join(root, "out.enc"), "--key-file", keyFile, "--make-key");
    expect(e.status).toBe(0);
    const keyHex = fs.readFileSync(keyFile, "utf8").trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(e.stdout + e.stderr).not.toContain(keyHex);

    const d = run("decrypt", "--in", path.join(root, "out.enc"), "--out", path.join(root, "back.bin"), "--key-file", keyFile);
    expect(d.status).toBe(0);
    expect(fs.readFileSync(path.join(root, "back.bin")).equals(plain)).toBe(true);

    expect(() => makeKeyFile(keyFile)).toThrow(/overwrite/);
    expect(run("encrypt", "--in", input, "--out", path.join(root, "out.enc"), "--key-file", keyFile).status).toBe(1); // output exists
  });
});
