#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build/release"
APP_DIR="$SCRIPT_DIR/dist/NeroScreenshot.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
ENTITLEMENTS_FILE="$SCRIPT_DIR/entitlements.plist"

echo "Building neros-screenshot..."
cd "$SCRIPT_DIR"
swift build -c release --arch arm64

echo "Creating .app bundle..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

cp "$BUILD_DIR/neros-screenshot" "$MACOS_DIR/"
cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/"

cat > "$ENTITLEMENTS_FILE" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
EOF

echo "Signing .app bundle..."
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS_FILE" "$APP_DIR"

rm -f "$ENTITLEMENTS_FILE"

echo ""
echo "Done! App bundle: $APP_DIR"
echo ""
echo "Run the following to trigger the Screen Recording permission prompt:"
echo "  open '$APP_DIR' && sleep 2 && osascript -e 'quit app \"NeroScreenshot\"' 2>/dev/null; true"
echo ""
echo "After granting permission in System Settings, restart Neros dev server."
