// swift-tools-version:5.3
// Portiv: sustituto local de capacitor-swift-pm 8.4.1 con slice de Mac Catalyst.
// iOS y Simulator son los binarios oficiales de la release 8.4.1; el slice
// maccatalyst se compiló del código fuente de la etiqueta 8.4.1 de ionic-team/capacitor
// (el paquete oficial no lo publica). Xcode lo usa en lugar del remoto porque el
// proyecto lo referencia como paquete local con la misma identidad.
import PackageDescription

let package = Package(
    name: "capacitor-swift-pm",
    products: [
        .library(name: "Capacitor", targets: ["Capacitor"]),
        .library(name: "Cordova", targets: ["Cordova"])
    ],
    dependencies: [],
    targets: [
        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),
        .binaryTarget(name: "Cordova", path: "Cordova.xcframework")
    ]
)
