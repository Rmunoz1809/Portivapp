import UIKit
import StoreKit
import Capacitor

/// Reseña nativa del App Store (23 nov 2026).
///
/// La web decide CUÁNDO pedirla (el 2º día distinto de uso, con la app tranquila: sin login,
/// muro, diapositivas ni cuestionario delante) y llama `Capacitor.Plugins.AppReview.requestReview()`.
/// Aquí solo se le pasa la petición a StoreKit, que es quien decide si muestra la tarjeta de
/// estrellas: Apple la limita a 3 veces por año y por usuario, y en TestFlight no sale nunca.
/// Funciona igual en iPhone, iPad y Mac (Catalyst).
@objc(AppReviewPlugin)
public class AppReviewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppReviewPlugin"
    public let jsName = "AppReview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise)
    ]

    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let scene = self.bridge?.viewController?.view.window?.windowScene
                ?? UIApplication.shared.connectedScenes
                    .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
            guard let windowScene = scene else {
                call.reject("Sin ventana activa")
                return
            }
            if #available(iOS 16.0, macCatalyst 16.0, *) {
                AppStore.requestReview(in: windowScene)
            } else {
                SKStoreReviewController.requestReview(in: windowScene)
            }
            call.resolve(["requested": true])
        }
    }
}
