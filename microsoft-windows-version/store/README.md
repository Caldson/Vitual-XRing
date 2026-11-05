# Microsoft Store submission

The generated Store package is:

```text
dist/Vitual XRing 8.2.2.appx
```

It is an x64 Windows Store (AppX) package built from the same Electron app.
The package can be unpacked and validated with `makeappx.exe unpack`.

## Before uploading

1. Open Partner Center → your app → **Product identity**.
2. Copy the exact identity values into `package.json` under `build.appx`:
   - `identityName`
   - `publisher`
   - `publisherDisplayName`
   - `applicationId`
3. Make sure the package version is a four-part version (`8.2.2.0`); the
   builder adds the fourth part automatically.
4. Sign the package with the certificate associated with the Partner Center
   publisher:
   ```powershell
   signtool sign /fd SHA256 /a /f your-certificate.pfx /p <password> "dist\Vitual XRing 8.2.2.appx"
   ```
   Store submissions require the package publisher to match the Partner Center
   identity. The package produced locally is intentionally left unsigned
   because no Partner Center certificate is stored in this repository.
5. Upload the signed `.appx` (or the equivalent `.msix`) in Partner Center.

## Store assets

Blue V assets are included in `assets/appx/`:

- StoreLogo.png
- Square44x44Logo.png
- Square150x150Logo.png
- Square310x310Logo.png
- Wide310x150Logo.png
- SplashScreen.png

## Rebuild

```powershell
npm run build:store
```

The current package uses language resources `zh-CN`, `en-US`, and `ja-JP`.
