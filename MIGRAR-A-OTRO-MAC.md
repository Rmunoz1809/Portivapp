# Montar Portiv en otro Mac

Todo lo necesario para web, iOS y Mac Catalyst está en este repo. Lo que NO está
(secretos y certificados) se pasa a mano: ver el final.

## 1. Clonar

```bash
git clone https://github.com/Rmunoz1809/Portivapp.git ~/Portiv
```

## 2. Web (portivapp.com)

```bash
cd ~/Portiv && npm install && npm run build
```

`index.html` de la raíz es el fuente; el push a `main` publica con GitHub Actions.

## 3. Proyecto de Xcode (iOS + Mac Catalyst)

`portiv-cap/` es una copia completa del proyecto que compila Xcode: `.xcodeproj`,
entitlements de iOS y de Mac, iconos de Mac, `scripts/icns-mac.sh`, `patches/` de
RevenueCat y el paquete local `ios/capacitor-swift-pm` con los xcframework de
Capacitor/Cordova **ya firmados** (no regenerarlos salvo al actualizar `@capacitor/ios`).

Se mantiene la misma ruta que en el Mac anterior (`~/Developer/portiv-cap`):

```bash
mkdir -p ~/Developer && cp -R ~/Portiv/portiv-cap ~/Developer/portiv-cap
cd ~/Developer/portiv-cap && npm install && npx cap copy ios
open ios/App/App.xcodeproj
```

`npm install` aplica el parche de RevenueCat (postinstall). `npx cap copy ios`
regenera `ios/App/App/public/`, `capacitor.config.json` y `config.xml`.

Comprobar que compila:

```bash
cd ~/Developer/portiv-cap/ios/App && xcodebuild -scheme App -project App.xcodeproj -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -3
```

```bash
cd ~/Developer/portiv-cap/ios/App && xcodebuild -scheme App -project App.xcodeproj -destination 'generic/platform=macOS,variant=Mac Catalyst' -configuration Debug CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -3
```

## 4. Lo que NO está en el repo (pasarlo a mano, p. ej. por AirDrop)

| Qué | Dónde estaba | Para qué |
|---|---|---|
| `.anthropic_key` | `~/Portiv/.anthropic_key` | IA en desarrollo local |
| `.env` (si existe) | `~/Portiv/.env` | claves de Paddle; plantilla en `.env.example` |
| Certificados de firma | Llavero ▸ "Apple Distribution" / "Apple Development" (exportar como `.p12`) | archivar y subir; firmar xcframeworks en `rebuild.sh` |
| Cuenta de Apple en Xcode | Xcode ▸ Settings ▸ Accounts | perfiles de aprovisionamiento |
| Instrucciones de Claude Code | `~/.claude/CLAUDE.md` | reglas de despliegue de Portiv |
| Supabase CLI | `supabase login` + `supabase link` | funciones y migraciones de `supabase/` |
| Vídeos de Instagram | `~/Portiv/instagram/` (481 MB) | marketing, no hace falta para programar |
