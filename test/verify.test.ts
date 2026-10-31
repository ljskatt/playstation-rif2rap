import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";
import { inspectGameFile } from "../src/lib/verify.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const rand = (n: number) => new Uint8Array(randomBytes(n));
const NP_KLIC_FREE = hex("72F990788F9CFF745725F08E4C128387");
const NP_KLIC_KEY = hex("F2FBCA7A75B04EDC1390638CCDFDD1EE");
const EDAT_KEY_0 = hex("BE959CA8308DEFA2E5E180C63712A9AE");
const EDAT_KEY_1 = hex("4CA9C14B01C95309969BEC68AA0BC081");
const CONTENT_ID = "UP0001-BLUS12345_00-GAMEDEMO00000001";

function makeEdat(klicensee: Uint8Array, { flags = 0x0c, version = 3, license = 2 } = {}) {
  const file = rand(0x200);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode("NPD\0"), 0);
  view.setInt32(0x04, version);
  view.setInt32(0x08, license);
  file.fill(0, 0x10, 0x40);
  file.set(new TextEncoder().encode(CONTENT_ID), 0x10);
  view.setUint32(0x80, flags);
  const edatKey = version === 4 ? EDAT_KEY_1 : EDAT_KEY_0;
  const hashKey = flags & 0x08 ? ecb(edatKey, { disablePadding: true }).decrypt(klicensee) : klicensee;
  file.set(cmac(file.subarray(0, 0xa0), hashKey), 0xa0);
  return file;
}

function makeSelf(klicensee: Uint8Array, { revision = 0x0a, license = 2 } = {}) {
  const erk = hex("03C21AD78FBB6A3D425E9AAB1298F9FD70E29FD4E6E3A3C151205DA50C413DE4");
  const riv = hex("0A99D4D4F8301A88052D714AD2FB565E");
  const file = new Uint8Array(0x800);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode("SCE\0"), 0);
  view.setUint16(0x08, revision);
  view.setUint32(0x0c, 0x400); // metadata info at 0x420
  view.setBigUint64(0x28, 0x70n); // program identification header
  view.setUint32(0x70 + 0x0c, 8); // NPDRM
  view.setBigUint64(0x58, 0x100n); // supplemental headers
  view.setBigUint64(0x60, 0x30n + 0x90n);
  view.setUint32(0x100, 1);
  view.setUint32(0x104, 0x30);
  view.setUint32(0x130, 3);
  view.setUint32(0x134, 0x90);
  file.set(new TextEncoder().encode("NPD\0"), 0x140);
  view.setInt32(0x148, license);
  file.set(new TextEncoder().encode(CONTENT_ID), 0x150);

  const info = new Uint8Array(0x40);
  info.set(rand(16), 0x00);
  info.set(rand(16), 0x20);
  const inner = cbc(erk, riv, { disablePadding: true }).encrypt(info);
  const npdrmKey = ecb(NP_KLIC_KEY, { disablePadding: true }).decrypt(klicensee);
  file.set(cbc(npdrmKey, new Uint8Array(16), { disablePadding: true }).encrypt(inner), 0x420);
  return file;
}

test("EDAT header hash accepts the right klicensee only", () => {
  for (const opts of [{ flags: 0x00 }, { flags: 0x0c }, { flags: 0x3c, version: 4 }]) {
    const klic = rand(16);
    const info = inspectGameFile(makeEdat(klic, opts));
    assert.equal(info.kind, "edat");
    assert.equal(info.contentId, CONTENT_ID);
    assert.equal(info.unusable, null);
    assert.equal(info.check(klic), true);
    assert.equal(info.check(rand(16)), false);
  }
});

test("EDAT edge cases are reported as unusable", () => {
  assert.match(inspectGameFile(makeEdat(rand(16), { flags: 0x01000000 })).unusable!, /SDAT/);
  assert.match(inspectGameFile(makeEdat(rand(16), { license: 3 })).unusable!, /free license/);
});

test("NPDRM SELF accepts the right klicensee only", () => {
  const klic = rand(16);
  const info = inspectGameFile(makeSelf(klic));
  assert.equal(info.kind, "self");
  assert.equal(info.contentId, CONTENT_ID);
  assert.equal(info.unusable, null);
  assert.equal(info.check(klic), true);
  let falsePositives = 0;
  for (let i = 0; i < 2000; i++) if (info.check(rand(16))) falsePositives++;
  assert.ok(falsePositives <= 1);
});

test("non-SELF files are rejected", () => {
  assert.throws(() => inspectGameFile(rand(64).fill(0x41, 0, 4)));
});

// Real homebrew EBOOT.BINs are free-license NPDRM SELFs signed with NP_KLIC_FREE,
// which exercises the SELF path on genuine files. Point REAL_SELF_DIR at a folder of them.
test("real free-license EBOOT.BIN files validate with NP_KLIC_FREE", { skip: !process.env.REAL_SELF_DIR }, () => {
  const dir = process.env.REAL_SELF_DIR!;
  for (const name of readdirSync(dir)) {
    const info = inspectGameFile(new Uint8Array(readFileSync(join(dir, name))));
    assert.match(info.unusable ?? "", /free license/, name);
    assert.equal(info.check(NP_KLIC_FREE), true, name);
    assert.equal(info.check(rand(16)), false, name);
  }
});
