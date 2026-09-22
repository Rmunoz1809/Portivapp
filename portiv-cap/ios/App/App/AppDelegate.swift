import UIKit
import WebKit
import Capacitor
import GoogleSignIn

/// Controlador de la app. Sólo añade una cosa sobre el de Capacitor: apagar el zoom.
///
/// El viewport y el CSS ya evitan que WKWebView amplíe al enfocar un campo, pero eso
/// es la capa web: si un `<meta>` se recalcula (el layout de iPad reescribe el suyo al
/// rotar) o una vista futura se olvida de la regla, el pinch vuelve. Fijar el zoom en
/// el scrollView del WebView lo cierra de raíz, y no hay forma de que la app quede
/// encallada a 2× como pasaba en el buscador de Watchlist.
class PortivViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let scrollView = webView?.scrollView else { return }
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 1.0
        scrollView.zoomScale = 1.0
        scrollView.bouncesZoom = false
        // El doble-tap-zoom y el pinch son gestos del propio scrollView: sin este
        // recognizer, WebKit no tiene por dónde iniciar una ampliación.
        scrollView.pinchGestureRecognizer?.isEnabled = false
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // ── Notificaciones push (APNs) ──
    // El plugin de Capacitor NO se engancha solo al AppDelegate: espera estos dos avisos
    // por NotificationCenter. Sin reenviarlos, `register()` se queda colgado para siempre:
    // el listener 'registration' del JS nunca dispara y tampoco llega un error. Silencio.
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications,
                                        object: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications,
                                        object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call

        // Google Sign-In vuelve por el URL scheme inverso del Client ID de iOS
        // (com.googleusercontent.apps.…). Si no le damos la URL al SDK, el callback
        // se pierde y el login nativo nunca resuelve.
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }

        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
 

// ── Ciclo de vida por escenas (obligatorio desde iOS/iPadOS 27) ──
// UIKit 27 ya no arranca apps con el ciclo antiguo de `UIApplicationDelegate` + `window`:
// aborta con EXC_BREAKPOINT antes de dibujar nada y el simulador se queda en negro.
// Capacitor 8 todavía genera la plantilla vieja, así que la escena se declara aquí.
//
// Ojo: con escenas las URLs entrantes YA NO pasan por `application(_:open:options:)`.
// Si no se reenvían desde aquí, el login de Google y los enlaces `portiv://` se pierden
// en silencio: sin callback y sin error.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // La ventana la crea UIKit desde Main.storyboard (UISceneStoryboardFile en el
        // Info.plist). Aquí sólo se recoge lo que llegó en un arranque en frío.
        for context in connectionOptions.urlContexts {
            handle(url: context.url, options: context.options)
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared,
                                                            continue: activity) { _ in }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            handle(url: context.url, options: context.options)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared,
                                                        continue: userActivity) { _ in }
    }

    @discardableResult
    private func handle(url: URL, options: UIScene.OpenURLOptions) -> Bool {
        // Mismo orden que en el AppDelegate: Google Sign-In primero, Capacitor después.
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }
        var appOptions: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: options.openInPlace]
        if let source = options.sourceApplication {
            appOptions[.sourceApplication] = source
        }
        if let annotation = options.annotation {
            appOptions[.annotation] = annotation
        }
        return ApplicationDelegateProxy.shared.application(UIApplication.shared,
                                                           open: url,
                                                           options: appOptions)
    }
}
