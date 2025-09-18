Add a custom macOS app icon

1) Put a 1024x1024 PNG at `build/icon.png` (square, no transparency issues).
2) Generate `.icns`:

   npm run icon:mac

   This creates `build/icon.icns` from your PNG.

3) Build the DMG:

   npm run dist:mac

The packaged app will use `build/icon.icns` as its icon.

