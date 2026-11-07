# Vitual XRing for Windows

This folder is the Windows desktop build of Vitual XRing.

## What is bundled

`prepare.js` copies the static site from the repository root into `www/`.
The desktop application starts a local server on `127.0.0.1` so the site keeps
its normal relative URLs, service-worker-free behavior, XOS, shop and local
assets. No page is loaded from the public website.

API and real-time features still use the Vitual XRing Workers API:

```text
https://xsmmc.caldson.us.ci/api
```

`prepare.js` injects `window.VTX_API_BASE` into every bundled HTML page, so
login, accounts, XOS cloud files, chat and other server-backed features keep
working. The public site itself is not contacted for HTML/CSS/JS/images.

## Development

```powershell
cd microsoft-windows-version
npm install
npm start
```

## Build the EXE

```powershell
npm run build:exe
```

Outputs in `dist/`:

- `VitualXRing-9.0.0-portable.exe`

This uses the local Electron runtime and a 7-Zip self-extracting executable
with the blue V icon.

### No administrator required

The portable EXE header gets an explicit `asInvoker` manifest before the
7-Zip archive is appended, so Windows never treats it as a legacy installer
that needs elevation. It extracts to the current user's `%TEMP%` folder and
runs entirely from there. The NSIS installer also uses a per-user install
(`perMachine: false`, `allowElevation: false`).

`build-portable.ps1` needs `mt.exe` from the Windows SDK once at build time.
If it is not auto-detected:

```powershell
$env:MT_EXE = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe"
npm run build:exe
```

## Microsoft Store package

```powershell
npm run build:store
```

This builds the Store `.appx` package. Before submitting, replace the
placeholder identity values in `package.json` (`build.appx`) with the values
from Partner Center:

- `identityName`
- `publisher`
- `publisherDisplayName`
- `applicationId`

The Store package also needs the Store icons in `assets/appx/` (already
included, blue V logo).

## Notes

- The app does not bundle a copy of the Workers API.
- GitHub/VitualGit API calls, payment APIs, XOS cloud files and chat are still
  network features and require internet access.
- `www/` and `dist/` are generated and ignored by Git.
