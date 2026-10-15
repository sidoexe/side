#!/bin/sh
# Builds an IPA for sideloading: ios/build/SideMobile.ipa.
#
# By default it is ad-hoc signed: the phone's UDID must be registered on the
# developer account; Xcode adds it and refreshes the profile with
# -allowProvisioningUpdates.
#
# With --unsigned it skips signing entirely, which needs no Apple account and
# is what CI publishes: LiveContainer signs what it installs itself.
#
# With --publish it also builds unsigned, and copies the IPA with a
# version.json to ~/.side-mobile (SIDE_IPA_DIR), which this Mac serves at
# <host>/ipa: the app compares its build number with it and offers the update.
set -eu
cd "$(dirname "$0")"
UNSIGNED=false
PUBLISH=false
case "${1:-}" in
  --unsigned) UNSIGNED=true ;;
  --publish) UNSIGNED=true; PUBLISH=true ;;
esac
xcodegen generate --quiet
rm -rf build/SideMobile.xcarchive build/export build/Payload build/SideMobile.ipa

if [ "$UNSIGNED" = true ]; then
  # A build number that only grows, so an installed copy knows it is older.
  BUILD=$(date -u +%Y%m%d%H%M)
  xcodebuild -project SideMobile.xcodeproj -scheme SideMobile -configuration Release \
    -destination generic/platform=iOS -archivePath build/SideMobile.xcarchive \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
    CURRENT_PROJECT_VERSION="$BUILD" archive -quiet
  mkdir build/Payload
  cp -R build/SideMobile.xcarchive/Products/Applications/SideMobile.app build/Payload/
  (cd build && zip -qry SideMobile.ipa Payload)
  rm -rf build/Payload
  if [ "$PUBLISH" = true ]; then
    DIR="${SIDE_IPA_DIR:-$HOME/.side-mobile}"
    VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' build/SideMobile.xcarchive/Products/Applications/SideMobile.app/Info.plist)
    mkdir -p "$DIR"
    cp build/SideMobile.ipa "$DIR/SideMobile.ipa.tmp" && mv "$DIR/SideMobile.ipa.tmp" "$DIR/SideMobile.ipa"
    printf '{"version":"%s","build":"%s"}\n' "$VERSION" "$BUILD" > "$DIR/version.json"
    echo "Published $VERSION ($BUILD) to $DIR"
  fi
  echo "$(pwd)/build/SideMobile.ipa"
  exit 0
fi

xcodebuild -project SideMobile.xcodeproj -scheme SideMobile -configuration Release \
  -destination generic/platform=iOS -archivePath build/SideMobile.xcarchive \
  -allowProvisioningUpdates archive -quiet
cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>release-testing</string>
  <key>teamID</key><string>J2SCD4VA8D</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/SideMobile.xcarchive -exportPath build/export \
  -exportOptionsPlist build/ExportOptions.plist -allowProvisioningUpdates -quiet
mv build/export/SideMobile.ipa build/SideMobile.ipa
echo "$(pwd)/build/SideMobile.ipa"
