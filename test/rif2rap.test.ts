import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ecb } from "@noble/ciphers/aes.js";
import {
  ACT_DAT_SIZE,
  RIF_SIZE,
  convertRif,
  klicenseeToRap,
  parseIdps,
  rapToKlicensee,
  toHex,
} from "../src/lib/rif2rap.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const enc = (k: Uint8Array, b: Uint8Array) => ecb(k, { disablePadding: true }).encrypt(b);
const dec = (k: Uint8Array, b: Uint8Array) => ecb(k, { disablePadding: true }).decrypt(b);

// Literal transcription of RPCS3's rap_to_rif() (rpcs3/Crypto/key_vault.cpp).
function rpcs3RapToRif(rap: Uint8Array): Uint8Array {
  const PBOX = hex("0C030604010B0F08020700050A0E0D09");
  const E1 = hex("A93E1FD67C55A329B75FDDA62A95C7A5");
  const E2 = hex("67D45DA3296D006A4E7C537BF5538C74");
  const key = dec(hex("869F7745C13FD890CCF29188E3CC3EDF"), rap);
  for (let round = 0; round < 5; ++round) {
    for (let i = 0; i < 16; ++i) key[PBOX[i]] ^= E1[PBOX[i]];
    for (let i = 15; i >= 1; --i) key[PBOX[i]] ^= key[PBOX[i - 1]];
    let o = 0;
    for (let i = 0; i < 16; ++i) {
      const p = PBOX[i];
      const kc = (key[p] - o) & 0xff;
      const ec2 = E2[p];
      if (o !== 1 || kc !== 0xff) {
        o = kc < ec2 ? 1 : 0;
        key[p] = (kc - ec2) & 0xff;
      } else if (kc === 0xff) {
        key[p] = (kc - ec2) & 0xff;
      } else {
        key[p] = kc;
      }
    }
  }
  return key;
}

test("klicenseeToRap is the exact inverse of RPCS3 rap_to_rif", () => {
  const edge = [new Uint8Array(16), new Uint8Array(16).fill(0xff)];
  for (const klic of [...edge, ...Array.from({ length: 5000 }, () => new Uint8Array(randomBytes(16)))]) {
    const rap = klicenseeToRap(klic);
    assert.equal(toHex(rpcs3RapToRif(rap)), toHex(klic));
    assert.equal(toHex(rapToKlicensee(rap)), toHex(klic));
  }
  for (let n = 0; n < 2000; n++) {
    const rap = new Uint8Array(randomBytes(16));
    assert.equal(toHex(rapToKlicensee(rap)), toHex(rpcs3RapToRif(rap)));
  }
});

test("full rif + act.dat + IDPS chain recovers the klicensee", () => {
  const NP_IDPS = hex("5E06E04FD94A71BF0000000000000001");
  const NP_RIF_KEY = hex("DA7D4B5E499A4F53B1C1A14A7484443B");
  const idps = hex("00000001008A000B14" + "1234567890ABCD");
  const klicensee = new Uint8Array(randomBytes(16));
  const actKey = new Uint8Array(randomBytes(16));
  const index = 42;
  const accountId = 0x1122334455667788n;

  const actDat = new Uint8Array(randomBytes(ACT_DAT_SIZE));
  new DataView(actDat.buffer).setBigUint64(0x08, accountId);
  actDat.set(enc(enc(idps, NP_IDPS), actKey), 0x10 + index * 0x10);

  const rif = new Uint8Array(RIF_SIZE);
  new DataView(rif.buffer).setBigUint64(0x08, accountId);
  rif.set(new TextEncoder().encode("UP0001-BLUS12345_00-GAMEDEMO00000001"), 0x10);
  const idxBlock = new Uint8Array(16);
  new DataView(idxBlock.buffer).setUint32(0x0c, index);
  rif.set(enc(NP_RIF_KEY, idxBlock), 0x40);
  rif.set(enc(actKey, klicensee), 0x50);

  const res = convertRif(rif, actDat, idps);
  assert.equal(res.actKeyIndex, index);
  assert.equal(toHex(res.klicensee), toHex(klicensee));
  assert.equal(res.fileName, "UP0001-BLUS12345_00-GAMEDEMO00000001.rap");
  assert.equal(res.accountMatches, true);
  assert.equal(toHex(rpcs3RapToRif(res.rap)), toHex(klicensee));
});

test("parseIdps accepts binary and hex text", () => {
  const bin = hex("00000001008A000B1400000000000000");
  assert.equal(toHex(parseIdps(bin)), toHex(bin));
  assert.equal(toHex(parseIdps("0x00000001 008A000B 14000000 00000000\n")), toHex(bin));
  assert.equal(toHex(parseIdps(new TextEncoder().encode("00000001008a000b1400000000000000"))), toHex(bin));
  assert.throws(() => parseIdps("1234"));
});
