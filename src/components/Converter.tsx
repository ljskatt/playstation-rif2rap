"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { zipSync } from "fflate";
import {
  ACT_DAT_SIZE,
  ConversionError,
  IDPS_SIZE,
  RIF_SIZE,
  convertRif,
  idpsLooksValid,
  parseActDat,
  parseIdps,
  toHex,
  type RapResult,
} from "@/lib/rif2rap";
import { GAME_FILE_HEAD_SIZE, inspectGameFile, looksLikeGameFile, type GameFileInfo } from "@/lib/verify";

interface LoadedFile {
  name: string;
  size: number;
  /** The whole file, or only its first GAME_FILE_HEAD_SIZE bytes for big game files. */
  bytes: Uint8Array;
}

type Slot = "rif" | "act" | "idps" | "game";

async function readFile(file: File): Promise<LoadedFile> {
  const bytes = new Uint8Array(await file.slice(0, GAME_FILE_HEAD_SIZE).arrayBuffer());
  return { name: file.name, size: file.size, bytes };
}

function classify(file: LoadedFile): Slot | null {
  const name = file.name.toLowerCase();
  if (looksLikeGameFile(file.bytes)) return "game";
  if (name.endsWith(".rif") || file.size === RIF_SIZE) return "rif";
  if (name === "act.dat" || file.size === ACT_DAT_SIZE) return "act";
  if (name.includes("idps") || file.size === IDPS_SIZE) return "idps";
  return null;
}

type GameCheck =
  | { file: LoadedFile; status: "error" | "unusable"; message: string }
  | { file: LoadedFile; status: "no-rap"; info: GameFileInfo }
  | { file: LoadedFile; status: "valid" | "invalid"; info: GameFileInfo; rap: RapResult };

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorMessage(e: unknown): string {
  if (e instanceof ConversionError) return e.message;
  return e instanceof Error ? `Unexpected error: ${e.message}` : String(e);
}

const IDPS_HEX_DIGITS = IDPS_SIZE * 2;

/** Keeps only hex digits (uppercased, max 32) and dashes; dashes are separators and don't count. */
function sanitizeIdpsInput(raw: string): string {
  let out = "";
  let digits = 0;
  for (const ch of raw.trim().replace(/^0x/i, "").toUpperCase()) {
    if (ch === "-") out += ch;
    else if (/[0-9A-F]/.test(ch) && digits < IDPS_HEX_DIGITS) {
      out += ch;
      digits++;
    }
  }
  return out;
}

type RifOutcome = { file: LoadedFile; result?: RapResult; error?: string };

function mergeByName(prev: LoadedFile[], added: LoadedFile[]): LoadedFile[] {
  const byName = new Map(prev.map((f) => [f.name, f]));
  for (const f of added) byName.set(f.name, f);
  return [...byName.values()];
}

export default function Converter() {
  const [rifs, setRifs] = useState<LoadedFile[]>([]);
  const [actDat, setActDat] = useState<LoadedFile | null>(null);
  const [idpsText, setIdpsText] = useState("");
  const [idpsSource, setIdpsSource] = useState<string | null>(null);
  const [gameFiles, setGameFiles] = useState<LoadedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const addFiles = useCallback(async (files: FileList | File[], forced?: Slot) => {
    const loaded = await Promise.all(Array.from(files).map(readFile));
    const ignored: string[] = [];
    const badIdps: string[] = [];
    const newRifs: LoadedFile[] = [];
    const newGameFiles: LoadedFile[] = [];
    for (const f of loaded) {
      const slot = forced ?? classify(f);
      if (slot === "rif") newRifs.push(f);
      else if (slot === "game") newGameFiles.push(f);
      else if (slot === "act") setActDat(f);
      else if (slot === "idps") {
        try {
          setIdpsText(toHex(parseIdps(f.bytes)));
          setIdpsSource(f.name);
        } catch {
          badIdps.push(f.name);
        }
      } else ignored.push(f.name);
    }
    if (newRifs.length) setRifs((prev) => mergeByName(prev, newRifs));
    if (newGameFiles.length) setGameFiles((prev) => mergeByName(prev, newGameFiles));
    const notices: string[] = [];
    if (ignored.length) {
      notices.push(
        `Could not tell what ${ignored.join(", ")} ${ignored.length === 1 ? "is" : "are"}. Use the matching box instead.`,
      );
    }
    if (badIdps.length) {
      notices.push(`${badIdps.join(", ")}: an IDPS file must be 16 bytes or contain 32 hex characters.`);
    }
    setNotice(notices.length ? notices.join(" ") : null);
  }, []);

  const idps = useMemo(() => {
    const digits = idpsText.replace(/-/g, "").length;
    if (digits !== IDPS_HEX_DIGITS) return { value: null, digits };
    const value = parseIdps(idpsText);
    return {
      value,
      digits,
      warning: idpsLooksValid(value) ? null : "This doesn't look like a console IDPS (it should start with 00000001).",
    };
  }, [idpsText]);

  const act = useMemo(() => {
    if (!actDat) return { error: null, accountId: null };
    try {
      return { error: null, accountId: parseActDat(actDat.bytes).accountId };
    } catch (e) {
      return { error: errorMessage(e), accountId: null };
    }
  }, [actDat]);

  const ready = rifs.length > 0 && actDat && !act.error && idps.value;

  const outcomes: RifOutcome[] = useMemo(() => {
    if (!ready) return [];
    return rifs.map((file) => {
      try {
        return { file, result: convertRif(file.bytes, actDat.bytes, idps.value!) };
      } catch (e) {
        return { file, error: errorMessage(e) };
      }
    });
  }, [ready, rifs, actDat, idps.value]);

  const successes = useMemo(() => outcomes.filter((o) => o.result).map((o) => o.result!), [outcomes]);

  const gameChecks: GameCheck[] = useMemo(
    () =>
      gameFiles.map((file): GameCheck => {
        let info: GameFileInfo;
        try {
          info = inspectGameFile(file.bytes);
        } catch (e) {
          return { file, status: "error", message: e instanceof Error ? e.message : String(e) };
        }
        if (info.unusable) return { file, status: "unusable", message: info.unusable };
        const rap = successes.find((r) => r.contentId === info.contentId);
        if (!rap) return { file, status: "no-rap", info };
        return { file, status: info.check(rap.klicensee) ? "valid" : "invalid", info, rap };
      }),
    [gameFiles, successes],
  );

  const downloadAll = () => {
    const entries: Record<string, Uint8Array> = {};
    for (const r of successes) entries[r.fileName] = r.rap;
    download("raps.zip", zipSync(entries, { level: 0 }));
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current--;
    if (dragDepth.current <= 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  const reset = () => {
    setRifs([]);
    setActDat(null);
    setIdpsText("");
    setIdpsSource(null);
    setGameFiles([]);
    setNotice(null);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="relative"
    >
      {dragging && (
        <div className="pointer-events-none absolute -inset-3 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-sky-400 bg-sky-950/70 backdrop-blur-sm">
          <p className="text-lg font-medium text-sky-100">Drop .rif, act.dat, IDPS or game files anywhere</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Step
          n={1}
          title=".rif license(s)"
          hint="One or more files from exdata/"
          done={rifs.length > 0}
          picker={<FilePicker label="Choose .rif" accept=".rif" multiple onFiles={(f) => addFiles(f, "rif")} />}
        >
          {rifs.length > 0 && (
            <ul className="space-y-1">
              {rifs.map((r) => (
                <li key={r.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono text-slate-300" title={r.name}>
                    {r.name}
                  </span>
                  <button
                    onClick={() => setRifs((prev) => prev.filter((p) => p.name !== r.name))}
                    className="shrink-0 text-slate-500 hover:text-rose-400"
                    aria-label={`Remove ${r.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step
          n={2}
          title="act.dat"
          hint="From the same exdata/ folder"
          done={!!actDat && !act.error}
          picker={<FilePicker label="Choose act.dat" accept=".dat" onFiles={(f) => addFiles(f, "act")} />}
        >
          {actDat && (
            <p className="truncate font-mono text-xs text-slate-300" title={actDat.name}>
              {actDat.name}
            </p>
          )}
          {act.error && <p className="text-xs text-rose-400">{act.error}</p>}
        </Step>

        <Step
          n={3}
          title="IDPS"
          hint="16-byte idps.bin or paste hex"
          done={!!idps.value}
          picker={<FilePicker label="Choose IDPS file" onFiles={(f) => addFiles(f, "idps")} />}
        >
          <input
            value={idpsText}
            onChange={(e) => {
              setIdpsText(sanitizeIdpsInput(e.target.value));
              setIdpsSource(null);
            }}
            placeholder="00000001008A000B14…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
          />
          {idpsSource && <p className="truncate text-xs text-slate-500">from {idpsSource}</p>}
          {idpsText && !idps.value && (
            <p className="text-xs text-slate-500">
              {idps.digits}/{IDPS_HEX_DIGITS} hex characters
            </p>
          )}
          {idps.warning && <p className="text-xs text-amber-400">{idps.warning}</p>}
          {idps.value && (
            <button
              onClick={() => download("idps.bin", idps.value)}
              className="self-start text-xs text-sky-400 hover:text-sky-300 hover:underline"
            >
              Download idps.bin
            </button>
          )}
        </Step>
      </div>

      {notice && <p className="mt-4 text-sm text-amber-400">{notice}</p>}

      <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-100">.rap files</h2>
          <div className="flex gap-2">
            {successes.length > 1 && (
              <button
                onClick={downloadAll}
                className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-sky-400"
              >
                Download all ({successes.length}) as .zip
              </button>
            )}
            {(rifs.length > 0 || actDat || idpsText || gameFiles.length > 0) && (
              <button
                onClick={reset}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {!ready ? (
          <p className="text-sm text-slate-400">Add all three inputs and your .rap files appear here instantly.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {outcomes.map(({ file, result, error }) => (
              <li key={file.name} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  {result ? (
                    <>
                      <p className="truncate font-mono text-sm text-slate-100">{result.fileName}</p>
                      <p className="truncate font-mono text-xs text-slate-500">
                        klicensee {toHex(result.klicensee)}
                      </p>
                      {!result.accountMatches && (
                        <p className="text-xs text-amber-400">
                          Warning: this .rif belongs to a different account than act.dat; the .rap will likely not work.
                        </p>
                      )}
                      <VerifiedBadge checks={gameChecks.filter((c) => "rap" in c && c.rap === result)} />
                    </>
                  ) : (
                    <>
                      <p className="truncate font-mono text-sm text-slate-300">{file.name}</p>
                      <p className="text-xs text-rose-400">{error}</p>
                    </>
                  )}
                </div>
                {result && (
                  <button
                    onClick={() => download(result.fileName, result.rap)}
                    className="shrink-0 rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-sky-400"
                  >
                    Download .rap
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold text-slate-100">
              Check against the game <span className="text-sm font-normal text-slate-500">(optional)</span>
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Add the game&apos;s <span className="font-mono text-slate-300">EBOOT.BIN</span> or any{" "}
              <span className="font-mono text-slate-300">.edat</span> from its{" "}
              <span className="font-mono text-slate-300">USRDIR</span> folder to confirm the .rap key is correct before
              starting RPCS3. Only the first 1 MB of each file is read.
            </p>
          </div>
          <FilePicker
            label="Choose game files"
            accept=".bin,.edat,.sprx,.self"
            multiple
            onFiles={(f) => addFiles(f, "game")}
          />
        </div>

        {gameChecks.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {gameChecks.map((c) => (
              <li key={c.file.name} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-slate-100" title={c.file.name}>
                    {c.file.name}
                  </p>
                  <GameCheckStatus check={c} />
                </div>
                <button
                  onClick={() => setGameFiles((prev) => prev.filter((p) => p.name !== c.file.name))}
                  className="shrink-0 text-slate-500 hover:text-rose-400"
                  aria-label={`Remove ${c.file.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GameCheckStatus({ check }: { check: GameCheck }) {
  switch (check.status) {
    case "valid":
      return <p className="text-xs text-emerald-400">✓ The .rap key for {check.info.contentId} matches this file.</p>;
    case "invalid":
      return (
        <p className="text-xs text-rose-400">
          ✗ Wrong key for {check.info.contentId}. Check that the IDPS and act.dat come from the console this .rif was
          activated on.
        </p>
      );
    case "no-rap":
      return (
        <p className="text-xs text-slate-400">
          Needs the .rap for <span className="font-mono">{check.info.contentId}</span>. Add its .rif, act.dat and IDPS
          above.
        </p>
      );
    case "unusable":
      return <p className="text-xs text-slate-400">{check.message}</p>;
    case "error":
      return <p className="text-xs text-rose-400">{check.message}</p>;
  }
}

function VerifiedBadge({ checks }: { checks: GameCheck[] }) {
  const valid = checks.filter((c) => c.status === "valid");
  const invalid = checks.filter((c) => c.status === "invalid");
  if (invalid.length) {
    return <p className="text-xs text-rose-400">✗ Rejected by {invalid.map((c) => c.file.name).join(", ")}</p>;
  }
  if (valid.length) {
    return <p className="text-xs text-emerald-400">✓ Verified with {valid.map((c) => c.file.name).join(", ")}</p>;
  }
  return null;
}

function Step({
  n,
  title,
  hint,
  done,
  picker,
  children,
}: {
  n: number;
  title: string;
  hint: string;
  done: boolean;
  picker: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border p-4 transition-colors ${
        done ? "border-sky-700/70 bg-sky-950/30" : "border-slate-800 bg-slate-900/50"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${
            done ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-400"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <div>
          <h3 className="font-medium text-slate-100">{title}</h3>
          <p className="text-xs text-slate-500">{hint}</p>
        </div>
      </div>
      {picker}
      {children}
    </div>
  );
}

function FilePicker({
  label,
  accept,
  multiple,
  onFiles,
}: {
  label: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList) => void;
}) {
  return (
    <label className="cursor-pointer rounded-md border border-dashed border-slate-700 px-3 py-2 text-center text-sm text-slate-300 hover:border-sky-500 hover:text-sky-300">
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}
