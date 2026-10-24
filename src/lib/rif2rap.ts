// Client-side RIF -> RAP conversion for PS3 NPDRM licenses.
//
// Key chain (same as scetool's klicensee_by_content_id):
//   idps_const' = AES-ECB-enc(key = IDPS,          NP_IDPS)
//   index       = be32(AES-ECB-dec(key = NP_RIF_KEY, rif[0x40..0x50]) @ 0xC)
//   act_key     = AES-ECB-dec(key = idps_const',    act.dat[0x10 + index * 0x10])
//   klicensee   = AES-ECB-dec(key = act_key,        rif[0x50..0x60])
// The RAP is the inverse of RPCS3's rap_to_rif() applied to the klicensee.

import { ecb } from "@noble/ciphers/aes.js";

export const RIF_SIZE = 0x98;
export const ACT_DAT_SIZE = 0x1038;
export const IDPS_SIZE = 0x10;
export const RAP_SIZE = 0x10;

const ACT_DAT_KEY_COUNT = 0x80;

const NP_IDPS = hex("5E06E04FD94A71BF0000000000000001");
const NP_RIF_KEY = hex("DA7D4B5E499A4F53B1C1A14A7484443B");
const RAP_KEY = hex("869F7745C13FD890CCF29188E3CC3EDF");
const RAP_PBOX = hex("0C030604010B0F08020700050A0E0D09");
const RAP_E1 = hex("A93E1FD67C55A329B75FDDA62A95C7A5");
const RAP_E2 = hex("67D45DA3296D006A4E7C537BF5538C74");

export class ConversionError extends Error {}

export interface RifInfo {
  contentId: string;
  accountId: bigint;
  actKeyIndex: number;
  klicensee: Uint8Array;
}

export interface ActDatInfo {
  accountId: bigint;
}

export interface RapResult extends RifInfo {
  rap: Uint8Array;
  fileName: string;
  /** False when the rif belongs to a different account than act.dat. */
  accountMatches: boolean;
}

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return ecb(key, { disablePadding: true }).encrypt(block);
}

function aesDecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return ecb(key, { disablePadding: true }).decrypt(block);
}

/**
 * Accepts either a raw 16-byte IDPS dump or text containing the IDPS as
 * 32 hex digits (spaces, dashes and a leading 0x are ignored).
 */
export function parseIdps(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (input.length === IDPS_SIZE) return input.slice();
    input = new TextDecoder().decode(input);
  }
  const clean = input.trim().replace(/^0x/i, "").replace(/[\s:-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new ConversionError(
      "IDPS must be 16 bytes (binary file) or 32 hex characters, e.g. 00000001008A000B14XXXXXXXXXXXXXX.",
    );
  }
  return hex(clean);
}

/** Real console IDPS values always start with 00 00 00 01. */
export function idpsLooksValid(idps: Uint8Array): boolean {
  return idps[0] === 0 && idps[1] === 0 && idps[2] === 0 && idps[3] === 1;
}

export function parseActDat(actDat: Uint8Array): ActDatInfo {
  if (actDat.length !== ACT_DAT_SIZE) {
    throw new ConversionError(
      `act.dat must be exactly ${ACT_DAT_SIZE} bytes (got ${actDat.length}).`,
    );
  }
  return { accountId: readU64(actDat, 0x08) };
}

export function rifToKlicensee(rif: Uint8Array, actDat: Uint8Array, idps: Uint8Array): RifInfo {
  if (rif.length !== RIF_SIZE) {
    throw new ConversionError(`A .rif file must be exactly ${RIF_SIZE} bytes (got ${rif.length}).`);
  }
  parseActDat(actDat);
  if (idps.length !== IDPS_SIZE) throw new ConversionError("IDPS must be 16 bytes.");

  const contentId = readContentId(rif);
  const accountId = readU64(rif, 0x08);

  const indexBlock = aesDecryptBlock(NP_RIF_KEY, rif.subarray(0x40, 0x50));
  const actKeyIndex = new DataView(indexBlock.buffer, indexBlock.byteOffset).getUint32(0x0c);
  if (actKeyIndex >= ACT_DAT_KEY_COUNT) {
    throw new ConversionError(
      `act.dat key index out of bounds (${actKeyIndex}). The .rif file is probably corrupt.`,
    );
  }

  const idpsConst = aesEncryptBlock(idps, NP_IDPS);
  const encActKey = actDat.subarray(0x10 + actKeyIndex * 0x10, 0x20 + actKeyIndex * 0x10);
  const actKey = aesDecryptBlock(idpsConst, encActKey);
  const klicensee = aesDecryptBlock(actKey, rif.subarray(0x50, 0x60));

  return { contentId, accountId, actKeyIndex, klicensee };
}

/** Inverse of RPCS3's rap_to_rif(). */
export function klicenseeToRap(klicensee: Uint8Array): Uint8Array {
  const key = klicensee.slice();
  for (let round = 0; round < 5; round++) {
    // Undo the 128-bit subtraction of E2 (bytes ordered by PBOX): add with carry.
    let carry = 0;
    for (let i = 0; i < 16; i++) {
      const p = RAP_PBOX[i];
      const sum = key[p] + RAP_E2[p] + carry;
      key[p] = sum & 0xff;
      carry = sum >> 8;
    }
    // Undo the chained XOR (forward pass ran from the top down).
    for (let i = 1; i < 16; i++) {
      key[RAP_PBOX[i]] ^= key[RAP_PBOX[i - 1]];
    }
    for (let i = 0; i < 16; i++) {
      const p = RAP_PBOX[i];
      key[p] ^= RAP_E1[p];
    }
  }
  return aesEncryptBlock(RAP_KEY, key);
}

/** Port of RPCS3's rap_to_rif(); used to self-check every conversion. */
export function rapToKlicensee(rap: Uint8Array): Uint8Array {
  const key = aesDecryptBlock(RAP_KEY, rap);
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 16; i++) {
      const p = RAP_PBOX[i];
      key[p] ^= RAP_E1[p];
    }
    for (let i = 15; i >= 1; i--) {
      key[RAP_PBOX[i]] ^= key[RAP_PBOX[i - 1]];
    }
    let borrow = 0;
    for (let i = 0; i < 16; i++) {
      const p = RAP_PBOX[i];
      const diff = key[p] - RAP_E2[p] - borrow;
      key[p] = diff & 0xff;
      borrow = diff < 0 ? 1 : 0;
    }
  }
  return key;
}

export function convertRif(rif: Uint8Array, actDat: Uint8Array, idps: Uint8Array): RapResult {
  const info = rifToKlicensee(rif, actDat, idps);
  const rap = klicenseeToRap(info.klicensee);
  if (toHex(rapToKlicensee(rap)) !== toHex(info.klicensee)) {
    throw new ConversionError("Internal error: RAP self-check failed.");
  }
  const actAccount = parseActDat(actDat).accountId;
  return {
    ...info,
    rap,
    fileName: `${info.contentId || "unknown"}.rap`,
    accountMatches: actAccount === info.accountId,
  };
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset);
}

function readContentId(rif: Uint8Array): string {
  const raw = rif.subarray(0x10, 0x40);
  const end = raw.indexOf(0);
  return new TextDecoder("ascii").decode(end === -1 ? raw : raw.subarray(0, end)).trim();
}
