#!/bin/bash
set -e

# CozyPane Release Script
# Builds macOS variants, uploads to R2 (with auto-update metadata), and deploys the landing page

VERSION=$(node -p "require('./package.json').version")
BUCKET="cozypane-downloads"
PAGES_PROJECT="cozypane-site"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== CozyPane Release v${VERSION} ==="

# Step 1: Build the app
echo ""
echo "[1/5] Building app..."
npm run build

# Step 2: Build macOS arm64 and x64
echo ""
echo "[2/5] Building macOS arm64..."
npx electron-builder --mac --arm64

echo ""
echo "[2/5] Building macOS x64..."
npx electron-builder --mac --x64

# Step 3: Upload versioned binaries to R2
echo ""
echo "[3/5] Uploading binaries to R2..."

ARM64_DMG=$(ls release/CozyPane-*-arm64.dmg 2>/dev/null | head -1)
X64_DMG=$(ls release/CozyPane-*-x64.dmg 2>/dev/null | head -1)
ARM64_ZIP=$(ls release/CozyPane-*-arm64-mac.zip 2>/dev/null | head -1)
X64_ZIP=$(ls release/CozyPane-*-x64-mac.zip 2>/dev/null | head -1)
LATEST_YML="release/latest-mac.yml"

for f in "$ARM64_DMG" "$X64_DMG" "$ARM64_ZIP" "$X64_ZIP" "$LATEST_YML"; do
  if [ -z "$f" ] || [ ! -f "$f" ]; then
    echo "ERROR: Expected file not found: $f"
    exit 1
  fi
done

echo "  Uploading $ARM64_DMG..."
npx wrangler r2 object put "${BUCKET}/v${VERSION}/$(basename "$ARM64_DMG")" --file="$ARM64_DMG"

echo "  Uploading $X64_DMG..."
npx wrangler r2 object put "${BUCKET}/v${VERSION}/$(basename "$X64_DMG")" --file="$X64_DMG"

echo "  Uploading $ARM64_ZIP..."
npx wrangler r2 object put "${BUCKET}/v${VERSION}/$(basename "$ARM64_ZIP")" --file="$ARM64_ZIP"

echo "  Uploading $X64_ZIP..."
npx wrangler r2 object put "${BUCKET}/v${VERSION}/$(basename "$X64_ZIP")" --file="$X64_ZIP"

# Step 4: Upload auto-update metadata to /latest/
echo ""
echo "[4/5] Uploading auto-update metadata..."
npx wrangler r2 object put "${BUCKET}/latest/latest-mac.yml" --file="$LATEST_YML" --content-type="text/yaml"

# Also upload the zips to /latest/ so the updater can find them
echo "  Uploading zips to /latest/..."
npx wrangler r2 object put "${BUCKET}/latest/$(basename "$ARM64_ZIP")" --file="$ARM64_ZIP"
npx wrangler r2 object put "${BUCKET}/latest/$(basename "$X64_ZIP")" --file="$X64_ZIP"

# Step 5: Deploy landing page
echo ""
echo "[5/5] Deploying landing page..."
npx wrangler pages deploy website/ --project-name="$PAGES_PROJECT" --commit-dirty=true

echo ""
echo "=== Release v${VERSION} complete! ==="
echo "  Landing page:  https://cozypane.com"
echo "  ARM64 DMG:     https://downloads.cozypane.com/v${VERSION}/$(basename "$ARM64_DMG")"
echo "  x64 DMG:       https://downloads.cozypane.com/v${VERSION}/$(basename "$X64_DMG")"
echo "  Auto-update:   https://downloads.cozypane.com/latest/latest-mac.yml"
