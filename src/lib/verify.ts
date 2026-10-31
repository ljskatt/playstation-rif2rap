// Checks a klicensee against a file from the game itself, the same way RPCS3 does:
//   EDAT:            CMAC of the first 0xA0 header bytes keyed with the klicensee (unedat.cpp check_data)
//   NPDRM SELF/SPRX: the klicensee unwraps the metadata info, whose padding must decrypt to zero
//                    (unself.cpp SELFDecrypter::LoadMetadata)

import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";

/** How many leading bytes of a game file the checks need (SELF headers are a few KB at most). */
export const GAME_FILE_HEAD_SIZE = 1024 * 1024;

const NP_KLIC_KEY = hex("F2FBCA7A75B04EDC1390638CCDFDD1EE");
const EDAT_KEY_0 = hex("BE959CA8308DEFA2E5E180C63712A9AE");
const EDAT_KEY_1 = hex("4CA9C14B01C95309969BEC68AA0BC081");

const SDAT_FLAG = 0x01000000;
const EDAT_ENCRYPTED_KEY_FLAG = 0x00000008;
const EDAT_DEBUG_DATA_FLAG = 0x80000000;

const SELF_TYPE_NPDRM = 8;
const SELF_DEBUG_FLAG = 0x8000;
const LICENSE_FREE = 3;

// [revision, erk, riv] from RPCS3's KeyVault::LoadSelfNPDRMKeys().
const NPDRM_SELF_KEYS: ReadonlyMap<number, { erk: Uint8Array; riv: Uint8Array }> = new Map(
  (
    [
      [0x0001, "F9EDD0301F770FABBA8863D9897F0FEA6551B09431F61312654E28F43533EA6B", "A551CCB4A42C37A734A2B4F9657D5540"],
      [0x0002, "8E737230C80E66AD0162EDDD32F1F774EE5E4E187449F19079437A508FCF9C86", "7AAECC60AD12AED90C348D8C11D2BED5"],
      [0x0003, "1B715B0C3E8DC4C1A5772EBA9C5D34F7CCFE5B82025D453F3167566497239664", "E31E206FBB8AEA27FAB0D9A2FFB6B62F"],
      [0x0004, "BB4DBF66B744A33934172D9F8379A7A5EA74CB0F559BB95D0E7AECE91702B706", "ADF7B207A15AC601110E61DDFC210AF6"],
      [0x0006, "8B4C52849765D2B5FA3D5628AFB17644D52B9FFEE235B4C0DB72A62867EAA020", "05719DF1B1D0306C03910ADDCE4AF887"],
      [0x0007, "3946DFAA141718C7BE339A0D6C26301C76B568AEBC5CD52652F2E2E0297437C3", "E4897BE553AE025CDCBF2B15D1C9234E"],
      [0x0009, "0786F4B0CA5937F515BDCE188F569B2EF3109A4DA0780A7AA07BD89C3350810A", "04AD3C2F122A3B35E804850CAD142C6D"],
      [0x000a, "03C21AD78FBB6A3D425E9AAB1298F9FD70E29FD4E6E3A3C151205DA50C413DE4", "0A99D4D4F8301A88052D714AD2FB565E"],
      [0x000c, "357EBBEA265FAEC271182D571C6CD2F62CFA04D325588F213DB6B2E0ED166D92", "D26E6DD2B74CD78E866E742E5571B84F"],
      [0x000d, "337A51416105B56E40D7CAF1B954CDAF4E7645F28379904F35F27E81CA7B6957", "8405C88E042280DBD794EC7E22B74002"],
      [0x000f, "135C098CBE6A3E037EBE9F2BB9B30218DDE8D68217346F9AD33203352FBB3291", "4070C898C2EAAD1634A288AA547A35A8"],
      [0x0010, "4B3CD10F6A6AA7D99F9B3A660C35ADE08EF01C2C336B9E46D1BB5678B4261A61", "C0F2AB86E6E0457552DB50D7219371C5"],
      [0x0013, "265C93CF48562EC5D18773BEB7689B8AD10C5EB6D21421455DEBC4FB128CBF46", "8DEA5FF959682A9B98B688CEA1EF4A1D"],
      [0x0016, "7910340483E419E55F0D33E4EA5410EEEC3AF47814667ECA2AA9D75602B14D4B", "4AD981431B98DFD39B6388EDAD742A8E"],
      [0x0019, "FBDA75963FE690CFF35B7AA7B408CF631744EDEF5F7931A04D58FD6A921FFDB3", "F72C1D80FFDA2E3BF085F4133E6D2805"],
      [0x001c, "8103EA9DB790578219C4CEDF0592B43064A7D98B601B6C7BC45108C4047AA80F", "246F4B8328BE6A2D394EDE20479247C5"],
    ] as const
  ).map(([rev, erk, riv]) => [rev, { erk: hex(erk), riv: hex(riv) }]),
);

export type GameFileKind = "edat" | "self";

export interface GameFileInfo {
  kind: GameFileKind;
  contentId: string;
  /** Why this file can't be used to check a .rap, if it can't. */
  unusable: string | null;
  check: (klicensee: Uint8Array) => boolean;
}

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readContentId(bytes: Uint8Array, offset: number): string {
  const raw = bytes.subarray(offset, offset + 0x30);
  const end = raw.indexOf(0);
  return new TextDecoder("ascii").decode(end === -1 ? raw : raw.subarray(0, end)).trim();
}

function need(head: Uint8Array, end: number) {
  if (head.length < end) throw new Error("The file is truncated or not a PS3 game file.");
}

/** True for files that start like an EDAT/SDAT ("NPD\0") or a SELF/SPRX ("SCE\0"). */
export function looksLikeGameFile(head: Uint8Array): boolean {
  const magic = new TextDecoder("latin1").decode(head.subarray(0, 4));
  return magic === "NPD\0" || magic === "SCE\0";
}

/**
 * Parses the start of an EDAT, SDAT, EBOOT.BIN or other SELF/SPRX file.
 * Throws for files that aren't any of those.
 */
export function inspectGameFile(head: Uint8Array): GameFileInfo {
  need(head, 4);
  const magic = new TextDecoder("latin1").decode(head.subarray(0, 4));
  if (magic === "NPD\0") return inspectEdat(head);
  if (magic === "SCE\0") return inspectSelf(head);
  throw new Error("Not an EDAT or SELF file (EBOOT.BIN, .edat, .sprx, .self).");
}

function inspectEdat(head: Uint8Array): GameFileInfo {
  need(head, 0xb0);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = view.getInt32(0x04);
  const license = view.getInt32(0x08);
  const flags = view.getUint32(0x80);
  const contentId = readContentId(head, 0x10);

  let unusable: string | null = null;
  if (flags & SDAT_FLAG) unusable = "SDAT files don't use a license, so they can't check a .rap.";
  else if ((license & 0x3) === LICENSE_FREE) unusable = "This file has a free license and doesn't need a .rap.";
  else if (flags & EDAT_DEBUG_DATA_FLAG) unusable = "Debug EDAT files carry no key to check against.";
  else if (version < 0 || version > 4) unusable = `Unknown EDAT version ${version}.`;

  const header = head.slice(0, 0xa0);
  const headerHash = head.slice(0xa0, 0xb0);

  return {
    kind: "edat",
    contentId,
    unusable,
    check: (klicensee) => {
      const hashKey =
        flags & EDAT_ENCRYPTED_KEY_FLAG
          ? ecb(version === 4 ? EDAT_KEY_1 : EDAT_KEY_0, { disablePadding: true }).decrypt(klicensee)
          : klicensee;
      return equal(cmac(header, hashKey), headerHash);
    },
  };
}

function inspectSelf(head: Uint8Array): GameFileInfo {
  need(head, 0x70);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const revision = view.getUint16(0x08);
  const metaOffset = view.getUint32(0x0c) + 0x20;
  const progIdOffset = Number(view.getBigUint64(0x28));
  const supplementalOffset = Number(view.getBigUint64(0x58));
  const supplementalSize = Number(view.getBigUint64(0x60));

  need(head, progIdOffset + 0x10);
  const programType = view.getUint32(progIdOffset + 0x0c);

  let npdOffset = -1;
  for (let pos = supplementalOffset; pos < supplementalOffset + supplementalSize; ) {
    need(head, pos + 0x10);
    const type = view.getUint32(pos);
    const size = view.getUint32(pos + 4);
    if (type === 3) {
      npdOffset = pos + 0x10;
      break;
    }
    if (size === 0) break;
    pos += size;
  }

  if (programType !== SELF_TYPE_NPDRM || npdOffset === -1) {
    return {
      kind: "self",
      contentId: "",
      unusable: "This is not a PSN (NPDRM) executable, so it doesn't use a .rap. Disc games don't need one.",
      check: () => false,
    };
  }

  need(head, npdOffset + 0x80);
  const license = view.getInt32(npdOffset + 0x08);
  const contentId = readContentId(head, npdOffset + 0x10);
  const keys = NPDRM_SELF_KEYS.get(revision);

  let unusable: string | null = null;
  if (license === LICENSE_FREE) unusable = "This file has a free license and doesn't need a .rap.";
  else if (revision & SELF_DEBUG_FLAG) unusable = "Debug SELF files carry no key to check against.";
  else if (!keys) unusable = `Unknown NPDRM key revision 0x${revision.toString(16)}.`;

  need(head, metaOffset + 0x40);
  const metadataInfo = head.slice(metaOffset, metaOffset + 0x40);

  return {
    kind: "self",
    contentId,
    unusable,
    check: (klicensee) => {
      if (!keys) return false;
      const npdrmKey = ecb(NP_KLIC_KEY, { disablePadding: true }).decrypt(klicensee);
      const inner = cbc(npdrmKey, new Uint8Array(16), { disablePadding: true }).decrypt(metadataInfo);
      const info = cbc(keys.erk, keys.riv, { disablePadding: true }).decrypt(inner);
      // Same test as RPCS3: key_pad and iv_pad must start with a zero byte.
      return info[0x10] === 0 && info[0x30] === 0;
    },
  };
}
