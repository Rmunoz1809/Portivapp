import Foundation
import Capacitor
import FacebookCore

/// Puente mínimo JS → Meta App Events. Sólo para medir campañas de Meta Ads: no hay
/// Facebook Login, ni IDFA, ni ATT.
///
/// La web llama `Capacitor.Plugins.MetaEvents.logEvent({ name, params })`. Los nombres
/// y parámetros van por lista blanca a propósito: un evento de Meta no puede llevar
/// nunca email, nombre, montos del portafolio ni tickers, y la forma más segura de
/// garantizarlo es que el lado nativo descarte cualquier cosa que no esté aquí.
///
/// Las compras (StartTrial / Subscribe) NO pasan por aquí: las manda RevenueCat a Meta
/// desde su servidor, que además ve renovaciones y conversiones de prueba con la app
/// cerrada. Mandarlas también desde la app las duplicaría.
@objc(MetaEventsPlugin)
public class MetaEventsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MetaEventsPlugin"
    public let jsName = "MetaEvents"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "logEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAnonymousId", returnType: CAPPluginReturnPromise)
    ]

    /// Evento → parámetros permitidos → valores permitidos.
    private static let allowed: [String: [String: Set<String>]] = [
        AppEvents.Name.completedRegistration.rawValue: [
            AppEvents.ParameterName.registrationMethod.rawValue: ["apple", "google", "email"]
        ],
        "ConnectBroker": [:]
    ]

    @objc func logEvent(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let schema = Self.allowed[name] else {
            call.reject("Evento no permitido")
            return
        }
        var parameters: [AppEvents.ParameterName: Any] = [:]
        for (key, value) in call.getObject("params") ?? [:] {
            guard let ok = schema[key], let v = value as? String, ok.contains(v) else { continue }
            parameters[AppEvents.ParameterName(key)] = v
        }
        AppEvents.shared.logEvent(AppEvents.Name(name), parameters: parameters)
        call.resolve()
    }

    /// ID anónimo que genera el SDK (no es el IDFA). Se le pasa a RevenueCat como
    /// `$fbAnonId` para que sus eventos de compra se atribuyan en Meta.
    @objc func getAnonymousId(_ call: CAPPluginCall) {
        call.resolve(["anonymousId": AppEvents.shared.anonymousID])
    }
}
