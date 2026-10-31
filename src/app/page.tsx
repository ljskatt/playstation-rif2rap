import Converter from "@/components/Converter";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-12 sm:py-16">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-50 sm:text-4xl">rif2rap</h1>
        <p className="mt-3 max-w-2xl text-slate-400">
          Turn PS3 <code className="font-mono text-slate-300">.rif</code> licenses into{" "}
          <code className="font-mono text-slate-300">.rap</code> files for RPCS3, using your{" "}
          <code className="font-mono text-slate-300">act.dat</code> and console IDPS.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-800/60 bg-emerald-950/40 px-3 py-1 text-xs text-emerald-300">
          Everything runs in your browser. Your files never leave this device.
        </p>
      </header>

      <Converter />

      <section className="mt-12 grid gap-6 text-sm text-slate-400 md:grid-cols-2">
        <div>
          <h2 className="mb-2 font-semibold text-slate-200">Where to find the files</h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <span className="text-slate-300">.rif</span> and <span className="text-slate-300">act.dat</span>:{" "}
              <code className="font-mono text-xs text-slate-300">/dev_hdd0/home/000000XX/exdata/</code> on the PS3
              (copy them off with FTP or a file manager).
            </li>
            <li>
              <span className="text-slate-300">IDPS</span>: dump it with a tool such as webMAN MOD or PS3 Toolset,
              either as a 16-byte <code className="font-mono text-xs text-slate-300">idps.bin</code> or as 32 hex
              characters.
            </li>
            <li>
              <span className="text-slate-300">EBOOT.BIN / .edat</span> (optional check):{" "}
              <code className="font-mono text-xs text-slate-300">/dev_hdd0/game/TITLEID/USRDIR/</code> on the PS3, or
              the same path inside RPCS3 after installing the game&apos;s .pkg.
            </li>
          </ul>
        </div>
        <div>
          <h2 className="mb-2 font-semibold text-slate-200">Using the .rap in RPCS3</h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Drag the <span className="text-slate-300">.rap</span> onto the RPCS3 window, or use{" "}
              <span className="text-slate-300">File → Install Packages/Raps/Edats</span>.
            </li>
            <li>
              Keep the file name: it must be the game&apos;s content ID, e.g.{" "}
              <code className="font-mono text-xs text-slate-300">UP0001-BLUS12345_00-….rap</code>.
            </li>
            <li>
              A wrong IDPS still produces a .rap, just a useless one. If the game won&apos;t start, double-check the
              IDPS first.
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
