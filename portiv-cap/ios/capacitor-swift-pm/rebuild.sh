#!/bin/zsh
# Regenera Capacitor.xcframework y Cordova.xcframework con slice de Mac Catalyst.
# Correr SIEMPRE que se actualice @capacitor/ios (la versión tiene que coincidir con la
# que fija CapApp-SPM/Package.swift). iOS y Simulator salen del binario oficial de la
# release; sólo el slice maccatalyst se compila desde el código fuente de la etiqueta.
# El slice maccatalyst lleva su dSYM dentro (-debug-symbols): sin él, al subir la app de
# Mac, App Store Connect avisa "Upload Symbols Failed ... dSYM for the A".
# Al final se FIRMA cada xcframework: Capacitor y Cordova están en la lista de SDK de uso
# común de Apple y, sin firma, App Store Connect acepta la subida pero rechaza el binario
# al enviarlo a revisión ("Archivo binario no válido"). Recombinar los slices borra la
# firma original de Ionic, así que firmamos con el certificado de distribución propio.
set -e
PKG=${0:A:h}
V=$(node -p "require('$PKG/../../node_modules/@capacitor/ios/package.json').version")
W=$(mktemp -d)
echo "Capacitor $V → $W"
git clone -q --depth 1 --branch $V https://github.com/ionic-team/capacitor.git $W/src
for F in Cordova Capacitor; do
  curl -sL -o $W/$F.zip https://github.com/ionic-team/capacitor-swift-pm/releases/download/$V/$F.xcframework.zip
  (cd $W && unzip -q -o $F.zip -d off-$F)
  xcodebuild archive -workspace $W/src/ios/Capacitor/Capacitor.xcworkspace -scheme $F \
    -destination 'generic/platform=macOS,variant=Mac Catalyst' -archivePath $W/$F-cat.xcarchive \
    -derivedDataPath $W/dd SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES \
    SUPPORTS_MACCATALYST=YES DEBUG_INFORMATION_FORMAT=dwarf-with-dsym CODE_SIGNING_ALLOWED=NO > $W/$F.log 2>&1
  OFF=$(find $W/off-$F -name "$F.xcframework" -maxdepth 2 | head -1)
  rm -rf $PKG/$F.xcframework
  xcodebuild -create-xcframework \
    -framework $OFF/ios-arm64/$F.framework \
    -framework $OFF/ios-arm64_x86_64-simulator/$F.framework \
    -framework $W/$F-cat.xcarchive/Products/Library/Frameworks/$F.framework \
    -debug-symbols $W/$F-cat.xcarchive/dSYMs/$F.framework.dSYM \
    -output $PKG/$F.xcframework
  codesign --timestamp -f -s "Apple Distribution: Rafael Muñoz (K97579JSV7)" $PKG/$F.xcframework
  codesign --verify --strict $PKG/$F.xcframework
done
echo "Listo. Limpiar SourcePackages de DerivedData si Xcode sigue usando el binario viejo."
