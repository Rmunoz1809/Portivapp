#!/bin/sh
# Mac Catalyst: con mínimo macOS ≥12, actool (Xcode 27) genera AppIcon.icns sólo con 16/32/128/256px
# y deja los tamaños grandes en Assets.car. App Store Connect exige 512 y 512@2x dentro del ICNS y,
# sin ellos, marca el build de macOS como "Archivo binario no válido" (2026-09-27).
# Se regenera el ICNS completo a partir de los mac-*.png del catálogo, antes de firmar.
set -e
[ "$PLATFORM_NAME" = "macosx" ] || exit 0
SRC="$SRCROOT/App/Assets.xcassets/AppIcon.appiconset"
DST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/AppIcon.icns"
SET="$DERIVED_FILE_DIR/AppIcon.iconset"
rm -rf "$SET"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  cp "$SRC/mac-$s.png" "$SET/icon_${s}x${s}.png"
  cp "$SRC/mac-$((s * 2)).png" "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o "$DST"
