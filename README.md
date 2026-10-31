# rif2rap-web

A static website that converts PS3 `.rif` licenses into `.rap` files for RPCS3.
Give it your `.rif` file(s), `act.dat` and console IDPS; it hands back one `.rap`
per license, named after the content ID. All crypto runs in the browser, so no
file ever leaves the user's machine and the site needs no backend.

## How it works

`src/lib/rif2rap.ts` follows the same key chain as scetool's
`klicensee_by_content_id`:

1. Encrypt the `NP_IDPS` constant with the console IDPS (AES-128-ECB).
2. Decrypt `rif[0x40..0x50]` with `NP_RIF_KEY` to get the act.dat key index.
3. Decrypt `act.dat[0x10 + index * 0x10]` with the key from step 1.
4. Decrypt `rif[0x50..0x60]` with that act.dat key to get the klicensee.
5. Run the inverse of RPCS3's `rap_to_rif()` on the klicensee to get the `.rap`.

Every result is checked by running it back through a port of `rap_to_rif()`.

### Checking a .rap against the game

`src/lib/verify.ts` can confirm a klicensee against a file from the game, the
same way RPCS3 does:

- **.edat**: CMAC of the first 0xA0 header bytes keyed with the klicensee must
  match the header hash at 0xA0 (`check_data` in RPCS3's `unedat.cpp`).
- **EBOOT.BIN / .sprx (NPDRM SELF)**: the klicensee unwraps the metadata info,
  whose key and IV padding must decrypt to zero (`LoadMetadata` in `unself.cpp`).

SDAT files and free-license content don't use a .rap, so they can't be used
for the check. Only the first 1 MB of each game file is read.

The SELF path can be tested against real files: homebrew `EBOOT.BIN`s are
free-license NPDRM SELFs, so `REAL_SELF_DIR=/path/to/ebootdir npm test` checks
that they validate with the free klicensee.

## Development

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # crypto tests (Node's built-in test runner)
npm run build   # static site in ./out
```

Upload the contents of `out/` to any static host (GitHub Pages, Netlify,
Cloudflare Pages, nginx, ...). To host under a sub-path, build with
`BASE_PATH=/rif2rap-web npm run build`.
