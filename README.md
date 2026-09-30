<div align="center">

**Español** | [English](README.en.md)

# 🛰️ Drone Swarm Mission Control (SWARM C2)

Dashboard 3D e interactivo que simula el **centro de mando de un enjambre autónomo de drones**.<br>
Todo está en un único archivo HTML: se abre y se queda funcionando solo.

[![Demo en vivo](https://img.shields.io/badge/▶_demo_en_vivo-bluongov.github.io%2Fdrone--swarm--c2-3ff0ff?style=for-the-badge)](https://bluongov.github.io/drone-swarm-c2/)

![stack](https://img.shields.io/badge/stack-Three.js%20r160-3ff0ff) ![deps](https://img.shields.io/badge/instalación-ninguna-ffcc33) ![archivo](https://img.shields.io/badge/archivo-único%20HTML-4dff9a)

![Demo](assets/demo.gif)

<sub>Vídeo en mejor calidad: [`assets/demo.mp4`](assets/demo.mp4)</sub>

</div>

---

## 📌 Por qué existe este proyecto

Nació como una **pantalla de ambiente para el escritorio**: algo visual, técnico y en movimiento constante para un monitor secundario. También sirve como demo y como ejercicio práctico de:

- **Gráficos 3D en el navegador** con Three.js (post-procesado, render múltiple, geometría instanciada).
- **Algoritmos de enjambre** (boids de Reynolds) con modos de misión, evitación de obstáculos y *geofencing*.
- **Diseño de HUDs** tipo centro de control: telemetría, mapa táctico, horizonte artificial y log de sistema.

Requisitos que se buscaban:
- **Vivo**: nunca se queda quieto. Los drones despegan, patrullan, cambian de misión y vuelven a cargar batería.
- **Creíble**: la telemetría, los logs y los términos (boids, EKF2, SLAM, geofence, MAVLink, RTK) son del mundo UAV/robótica real, aunque los datos sean simulados.
- **Interactivo**: se puede hacer clic, cambiar de modo y escribir comandos en una terminal integrada.
- **Sin fricción**: un solo archivo, sin instalar nada y sin servidor.

> ⚠️ **Todo es una simulación.** No se conecta a drones, redes ni sistemas reales. Los mensajes del log y los valores de telemetría se generan de forma procedural.

---

## 🚀 Cómo usarlo

**Online:** 👉 **https://bluongov.github.io/drone-swarm-c2/**

**En local:**
```bash
git clone git@github.com:bluongov/drone-swarm-c2.git
cd drone-swarm-c2

# Opción 1: doble clic en index.html
# Opción 2: desde terminal (Linux)
xdg-open index.html
# Opción 3: servidor local (recomendado; así los cambios se guardan en la URL)
python3 -m http.server 8080   # → http://localhost:8080
```

Después pulsa **`F`** para pantalla completa y déjalo corriendo.

**Requisitos:** un navegador moderno con WebGL (Chrome, Edge o Firefox) y **conexión a internet**, porque Three.js se carga desde el CDN de jsDelivr.

---

## 🎮 Controles de teclado y ratón

| Tecla / acción | Qué hace |
|---|---|
| **Clic en el suelo** | En `PATROL` inserta un waypoint prioritario. En los demás modos el enjambre pasa a **orbitar** ese punto. |
| **Arrastrar / rueda** | Rotar y hacer zoom con la cámara (OrbitControls) |
| `1` `2` `3` `4` | Modo `PATROL` · `ORBIT` · `FORMATION` · `SCAN` |
| `C` | Alterna entre cámara orbital general y **cámara de persecución** del drone seleccionado |
| `A` | Activa o desactiva la rotación automática de modos (cada 50 s) |
| `H` | Oculta o muestra el HUD (queda solo la escena 3D) |
| `F` | Pantalla completa |
| `Enter` o `/` | Abre la terminal integrada para escribir comandos |
| `Esc` | Sale de la terminal |
| Clic en una celda de *Fleet Matrix* | Selecciona ese drone (cámara FPV, horizonte y telemetría) |

---

## 💻 Comandos de la terminal integrada

El panel **SYSTEM LOG** funciona como terminal (`c2@halcyon:~$`). Pulsa `Enter`, escribe y vuelve a pulsar `Enter`. Las flechas `↑`/`↓` recorren el historial.

| Comando | Ejemplo | Descripción |
|---|---|---|
| `help` | `help` | Lista los comandos |
| `drones=N` | `drones=40` · `drones 5` | Cambia **en caliente** el tamaño del enjambre (1–150). Los nuevos drones despegan escalonados y los sobrantes se retiran. |
| `mode=...` | `mode=orbit` · `mode scan` | `patrol`, `orbit`, `formation` o `scan` |
| `quality=low\|high` | `quality=low` | `low` usa resolución 1x y desactiva el bloom (**más FPS**) |
| `name=TEXTO` | `name=Skynet` | Cambia el nombre del proyecto en la cabecera (máximo 24 caracteres) |
| `auto=on\|off` | `auto=off` | Rotación automática de modos |
| `status` | `status` | Resumen: drones activos, en RTB y cargando, modo, calidad y FPS |
| `clear` | `clear` | Limpia el log |

Tanto `drones=40` como `drones 40` son válidos. Cuando el navegador lo permite, los cambios de `drones`, `name` y `quality` se guardan en la URL, así que sobreviven a un F5. Con `file://` algunos navegadores lo bloquean; en ese caso usa un servidor local.

---

## 🔗 Parámetros por URL

Sirven para arrancar ya configurado:

```
index.html?name=SKYNET&drones=40&quality=low&lat=40.4168&lon=-3.7038
```

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `name` | `HALCYON` | Nombre del proyecto |
| `drones` | `60` | Número de drones (1–150) |
| `quality` | `high` | `low` para equipos modestos |
| `lat`, `lon` | Valencia (39.4699, -0.3763) | Origen de las coordenadas GPS que se muestran |

---

## ⚡ Rendimiento

Si va lento:
1. `quality=low` en la terminal (el bloom es lo más costoso).
2. `drones=30` o menos.
3. `H` oculta el HUD, y con él también se deja de renderizar la cámara FPV (un render menos por frame).

El contador de FPS está arriba a la derecha y también sale en `status`.

---

## 🧩 Qué se ve en pantalla

```
┌──────────────────────────── PROJECT X // AUTONOMOUS SWARM C2 ── MODE ── UTC ── T+ ── FPS ─┐
│ SWARM STATUS  │                                              │ TACTICAL MAP (radar,       │
│ (activos, RTB,│                                              │ cobertura, NFZ, rutas)     │
│ carga, bat,   │            ESCENA 3D (Three.js)              ├────────────────────────────┤
│ link, cober.) │   ciudad wireframe · enjambre · NFZ · base   │ FPV FEED (cámara del drone)│
├───────────────┤                                              ├────────────────────────────┤
│ FLEET MATRIX  │                                              │ FOCUS UNIT (horizonte      │
│ (bat/estado   │                                              │ artificial + telemetría)   │
│ por drone)    │                                              │                            │
├───────────────┴──────────────────────────────────────────────┼────────────────────────────┤
│ SYSTEM LOG + terminal interactiva                            │ TELEMETRY (THRPT/ALT/LAT)  │
└──────────────────────────────────────────────────────────────┴────────────────────────────┘
```

- **Escena 3D**: terreno wireframe con relieve en las afueras, 28 edificios generados al azar con balizas rojas, 2 zonas de exclusión aérea (cilindros rojos), base de carga con plataformas, drones con LEDs de estado, estroboscopio y estelas.
- **Drone seleccionado**: anillo, cono de escaneo al suelo y etiqueta flotante. Cambia cada 10 s.
- **Banner** “RETASKING SWARM” cada vez que cambia la misión.

---

## 🛠️ Cómo se hizo (referencia técnica)

### Stack
- **Un solo archivo**: `index.html` (HTML, CSS y JS en un módulo ES).
- **Three.js r160** vía `importmap` desde jsDelivr, sin bundler ni `npm install`.
- Addons de Three.js: `OrbitControls`, `EffectComposer` + `UnrealBloomPass` + `OutputPass` (bloom) y `BufferGeometryUtils.mergeGeometries` (geometría del drone).
- HUD en **HTML/CSS** con paneles `backdrop-filter`, esquinas decorativas y scanlines, más **Canvas 2D** para el mapa, el horizonte y las gráficas.

### 1. Algoritmo de enjambre (Boids de Reynolds)
Cada drone calcula su aceleración como suma ponderada de varias fuerzas de *steering* (`deseado − velocidad`, limitado a `MAXF`):

| Fuerza | Qué hace |
|---|---|
| **Separación** | Se aleja de los vecinos a menos de `R_SEP = 7`, con peso `1/d²` |
| **Alineación** | Iguala la velocidad media de los vecinos a menos de `R_NEI = 16` |
| **Cohesión** | Se dirige al centro de masa de los vecinos |
| **Objetivo** | Busca su *goal* con *arrival*: frena al acercarse |
| **Evitación** | Empuje radial lejos de edificios y NFZ, más empuje vertical sobre azoteas |
| **Límites** | Altitud entre 14 y 100 m y área de ±200 m |

Los pesos cambian según el modo (`MODE_W`):

| Modo | Comportamiento | Cómo se calcula el goal |
|---|---|---|
| `PATROL` | Flocking clásico (alineación y cohesión altas) | Waypoint actual más un offset por drone. Cuando el centroide llega a menos de 30 m, pasa al siguiente. Al acabar la ruta se genera otra. |
| `ORBIT` | Anillos concéntricos (3 radios y alturas, uno en sentido contrario) | `centro + (cos a·R, alt, sin a·R)` con fase repartida por *slot* |
| `FORMATION` | Formación en V (chevron) tras un líder virtual | El líder sigue una curva de Lissajous y los slots se calculan con sus vectores *forward* y *right* |
| `SCAN` | Cortina que barre la ciudad | Carriles en X (alturas alternas para no chocar) y Z oscilante |

Los *slots* se reasignan cada 2 s, o cuando cambia el número de drones activos, ordenando por posición (X en SCAN, ángulo en ORBIT, distancia al líder en FORMATION) para que no se crucen.

Es O(n²) por frame, suficiente hasta 150 drones.

### 2. Máquina de estados por drone
```
IDLE ──(delay escalonado)──► LAUNCH ──(alt>24m)──► ACTIVE ──(bat<15%)──► RTB
  ▲                                                                       │
  └──────────── CHARGING ◄──(toca pad)── LANDING ◄──(sobre su pad)────────┘
                    │ (bat=100%)
                    └──────────► LAUNCH
```
- La batería se descarga entre 0,32 y 0,6 %/s (varía por drone) y carga a 8 %/s. Así siempre hay drones yendo y viniendo de la base, lo que añade movimiento y eventos al log.
- Color del LED: cian (ACTIVE), amarillo (RTB/LANDING), verde parpadeante (CHARGING) y blanco (LAUNCH).
- La orientación sale de la velocidad (yaw) y de la aceleración (pitch hacia delante y roll en los giros), igual que se inclina un cuadricóptero real.

### 3. Render
- **Bloom** (`UnrealBloomPass`) para el look de neón. Se desactiva con `quality=low`.
- **Cámara FPV**: se renderiza la misma escena una segunda vez con otra cámara, usando `setViewport` y `setScissor` sobre el rectángulo del panel FPV. Ese panel no tiene fondo ni blur para que se vea el render de debajo. Durante ese render se ocultan el drone y sus marcadores.
- **Estelas**: `THREE.Line` con buffer circular de 40 puntos, colores degradados y `AdditiveBlending`.
- Plataformas de carga con `InstancedMesh`, que se reconstruye al cambiar el número de drones.

### 4. HUD y datos
- **Mapa táctico**: edificios, NFZ, barrido de radar, ruta y waypoints, drones por color de estado y un **mapa de cobertura**. La rejilla es de 24×24 celdas; una celda cuenta como cubierta si un drone activo pasó por ella en los últimos 90 s. Ese valor es el % de COVERAGE, que se calcula de verdad.
- **Telemetría del drone seleccionado**:
  - Reales de la simulación: ALT, SPD, HDG, BAT y LINK (depende de la distancia a la base).
  - Derivados: RPM y temperatura del ESC.
  - LAT/LON: posición convertida a grados a partir de `lat`/`lon` (1 unidad = 1 m).
- **Log**: mensajes de arranque, eventos reales de la simulación (RTB, aterrizajes, waypoints, geofence, cambios de modo) y “chatter” procedural cada 0,35–1,3 s (SLAM, EKF2, mesh, visión, consenso, AR-overlay…).
- El HUD de texto se actualiza cada 250 ms. El mapa y el horizonte se dibujan en cada frame.
- El layout se adapta a la altura de la pantalla: el mapa y el FPV escalan con `vh`.

### 5. Terminal interactiva
Es un `<input>` dentro del panel de log. `runCmd()` parsea `comando[=| ]argumento`. `setDroneCount()` hace lo siguiente:
- Libera los drones sobrantes (`dispose()` de materiales y geometrías).
- Reconstruye las plataformas y reasigna la plataforma de cada drone.
- Crea los nuevos drones con despegue escalonado.
- Regenera el panel *Fleet Matrix*.

Los atajos de teclado se ignoran mientras escribes en la terminal.

### 6. Cómo se verificó
- `node --check` sobre el script extraído (sintaxis).
- **Playwright + Chromium headless** (WebGL por SwiftShader): se abrió la página, se probaron los modos, el clic en el suelo, la cámara de persecución y todos los comandos de terminal (`help`, `drones=10/25/5`, `mode orbit`, `quality=low`, `name=...`, un comando inexistente y `status`), revisando capturas y que no hubiera errores en consola.

### 7. Cómo se generó el GIF
El render por software de un navegador headless va a ~4 FPS, así que se usa **`page.clock` de Playwright** (tiempo virtual). El script avanza el reloj 1/12 s, hace una captura y repite, de modo que la animación sale fluida sin depender del rendimiento real. Script: [`tools/record-gif.mjs`](tools/record-gif.mjs).

```bash
npm i --no-save playwright gifsicle && npx playwright install chromium
node tools/record-gif.mjs                                   # → frames/*.png (1600x900, 12 fps)

# GIF (paleta optimizada + compresión con pérdida → ~6 MB)
ffmpeg -framerate 12 -i frames/f%04d.png -vf "fps=8,scale=720:-1:flags=lanczos,palettegen=max_colors=64:stats_mode=diff" pal.png
ffmpeg -framerate 12 -i frames/f%04d.png -i pal.png -lavfi "fps=8,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" tmp.gif
npx gifsicle -O3 --lossy=100 tmp.gif -o assets/demo.gif

# MP4 en mejor calidad
ffmpeg -framerate 12 -i frames/f%04d.png -vf scale=1280:-2 -c:v libx264 -pix_fmt yuv420p -crf 28 -movflags +faststart assets/demo.mp4
```

Durante la grabación se ocultan las scanlines (`#fx`), porque el patrón de líneas hace que el GIF pese varias veces más.

---

## 🔧 Dónde tocar para personalizar

Todo está en `index.html`, en el `<script type="module">`:

| Qué | Dónde |
|---|---|
| Velocidad, fuerza y radios de vecinos | `const MAXS, MAXF, R_NEI, R_SEP` |
| Pesos de flocking por modo | `const MODE_W` |
| Colores por estado | `STATE_COLOR` y variables CSS `:root` (`--c`, `--g`, `--y`, `--r`) |
| Cada cuánto cambia de modo | `modeTimer > 50` en el loop principal |
| Cada cuánto cambia el drone seleccionado | `focusTimer > 10` |
| Descarga y carga de batería | `this.drain = rand(...)` · `dt * 8` · `battery < 15` |
| Número de edificios y NFZ | bloque `CITY / OBSTACLES` |
| Mensajes del log | array `gen` en `chatter()` y array `boot` |
| Nuevos comandos de terminal | `switch (cmd)` en `runCmd()` |

---

## 💡 Ideas para más adelante
- Modo **realidad aumentada** con webcam y MediaPipe (hand/face tracking) en un panel.
- Tráfico aéreo real (ADS-B) en el mapa.
- Incluir Three.js en local (`vendor/`) para que funcione sin internet.
- Rejilla espacial para los vecinos de boids y así soportar más de 500 drones.
- Tema de color configurable (`theme=amber`, `theme=green`).

---

## 📁 Estructura

```
drone-swarm-c2/
├── index.html            # toda la app (HTML + CSS + JS)
├── README.md             # documentación (español)
├── README.en.md          # documentation (English)
├── assets/
│   ├── demo.gif          # GIF del README
│   ├── demo.mp4          # vídeo en mejor calidad
│   └── screenshot.png
└── tools/
    └── record-gif.mjs    # grabación de la demo con Playwright (reloj virtual)
```
