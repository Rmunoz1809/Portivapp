import UIKit
import WebKit
import Capacitor

/// Navegador dentro de la app para el Mac.
///
/// En iPhone y iPad, `@capacitor/browser` (SFSafariViewController) y Google Sign-In
/// (ASWebAuthenticationSession) ya se abren como hoja dentro de Portiv. En Mac Catalyst los
/// dos se los pasa macOS al navegador predeterminado (Chrome, Safari…) y el usuario sale de
/// la app. Este plugin abre la página en una ventana propia, con WKWebView, encima de Portiv.
///
/// La web llama `Capacitor.Plugins.WebSheet.open({ url, returnPrefixes, title })`. Cuando la
/// página intenta ir a una dirección que empieza por uno de `returnPrefixes` (el deep link
/// `portiv://` de SnapTrade, el `redirectTo` del OAuth de Google), la navegación se corta, la
/// ventana se cierra y la promesa devuelve `{ url }`. Si el usuario la cierra, `{ closed: true }`.
@objc(WebSheetPlugin)
public class WebSheetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebSheetPlugin"
    public let jsName = "WebSheet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private weak var sheet: WebSheetViewController?

    @objc func open(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            call.reject("URL no válida")
            return
        }
        let prefixes = (call.getArray("returnPrefixes", String.self) ?? []).filter { !$0.isEmpty }
        let title = call.getString("title") ?? ""
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("Sin ventana donde abrir")
                return
            }
            // Una sola ventana a la vez: si quedó otra abierta, se cierra como cancelada.
            self.sheet?.finish(nil)
            let vc = WebSheetViewController(url: url, returnPrefixes: prefixes, title: title) { returned in
                if let returned = returned {
                    call.resolve(["url": returned.absoluteString])
                } else {
                    call.resolve(["closed": true])
                }
            }
            self.sheet = vc
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .pageSheet
            nav.isModalInPresentation = true   // se cierra con el botón, no deslizando por error
            var top = host
            while let presented = top.presentedViewController { top = presented }
            top.present(nav, animated: true)
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.sheet?.finish(nil)
            call.resolve()
        }
    }
}

final class WebSheetViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let startURL: URL
    private let returnPrefixes: [String]
    private let sheetTitle: String
    private var completion: ((URL?) -> Void)?
    private var webView: WKWebView!

    /// Google rechaza los navegadores incrustados («disallowed_useragent») por el user agent.
    /// En sus páginas la ventana se presenta como Safari de Mac.
    private static let safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    init(url: URL, returnPrefixes: [String], title: String, completion: @escaping (URL?) -> Void) {
        self.startURL = url
        self.returnPrefixes = returnPrefixes
        self.sheetTitle = title
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) no se usa") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = sheetTitle.isEmpty ? (startURL.host ?? "") : sheetTitle
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Cerrar", style: .plain, target: self, action: #selector(closeTapped))

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.customUserAgent = Self.safariUA
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView.load(URLRequest(url: startURL))
    }

    @objc private func closeTapped() { finish(nil) }

    /// Cierra la ventana y entrega el resultado una sola vez.
    func finish(_ returned: URL?) {
        guard let done = completion else { return }
        completion = nil
        webView?.stopLoading()
        (navigationController ?? self).dismiss(animated: true)
        done(returned)
    }

    private func isReturn(_ url: URL) -> Bool {
        let s = url.absoluteString
        return returnPrefixes.contains { s.hasPrefix($0) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        if isReturn(url) {
            decisionHandler(.cancel)
            finish(url)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["http", "https", "about", "data", "blob"].contains(scheme) {
            decisionHandler(.allow)
        } else {
            // Otro esquema (la app de un broker, mailto…): no hay página que mostrar aquí.
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        }
    }

    /// `window.open` / `target=_blank` (los brokers con OAuth lo usan): se abre en la misma ventana.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            if isReturn(url) { finish(url) } else { webView.load(navigationAction.request) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if sheetTitle.isEmpty { title = webView.url?.host ?? title }
    }
}
