# MoonWolf Agent (Rust)

Reescritura nativa del Agent de [MoonWolf-Panel](https://github.com/Santyxs/MoonWolf-Panel) **sin Node.js**.

## Qué incluye

| Módulo | Estado | Descripción |
|--------|--------|-------------|
| `config` | ✅ | `agent.json` en `%APPDATA%\\MoonWolf`, tokens, `serverDir` |
| `local` | ✅ | API HTTP en `127.0.0.1:10000` (health, files, state) |
| `cloud` | ✅ | Cliente Socket.IO → MoonWolf Cloud (register, pairing, RPC) |
| `update` | ✅ | Comprueba GitHub Releases y descarga el `.exe` |
| `gui` | ✅ | WebView (wry/tao) + UI HTML |
| `direct` | 🧩 | Esqueleto WebRTC (feature `webrtc`) |

## Compilar (solo desarrollo)

```bash
cd agent
cargo build --release
```

**Usuarios finales:** no necesitan Rust. Descarga `MoonWolf-Agent.exe` desde [Releases](https://github.com/Santyxs/MoonWolf-Panel/releases).

## GitHub Actions

El workflow `.github/workflows/build-agent.yml` compila en Windows y publica el release automáticamente.

## Configuración

- Windows: `%APPDATA%\\MoonWolf\\agent.json`
- Campos: `agentId`, `agentToken`, `localToken`, `sessionSecret`, `serverDir`, `autoStart`
