<div align="center">

**Español** | [English](README.en.md)

# 🛰️ Drone Swarm Mission Control (SWARM C2)

Dashboard 3D e interactivo que simula el **centro de mando de un enjambre autónomo de drones**.<br>
El escenario es la Ciutat de les Arts i les Ciències de València, reconstruida con vóxeles; la app se abre con doble clic y funciona sin build ni instalación.

[![Demo en vivo](https://img.shields.io/badge/▶_demo_en_vivo-bluongov.github.io%2Fdrone--swarm--c2-3ff0ff?style=for-the-badge)](https://bluongov.github.io/drone-swarm-c2/)

![stack](https://img.shields.io/badge/stack-Three.js%20r160-3ff0ff) ![deps](https://img.shields.io/badge/instalación-ninguna-ffcc33) ![build](https://img.shields.io/badge/build-ninguno-4dff9a)

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
- **Sin fricción**: sin build ni instalación; basta abrir `index.html` con doble clic.

> ⚠️ **Todo es una simulación.** No se conecta a drones, redes ni sistemas reales. Los mensajes del log y los valores de telemetría se generan de forma procedural.

---

## 🚀 Cómo usarlo

**Online:** 👉 **https://bluongov.github.io/drone-swarm-c2/**

**En local:**
```bash
git clone git@github.com:bluongov/drone-swarm-c2.git
cd drone-swarm-c2

# Servidor estático (necesario: la simulación es un módulo ES, sim-core.js, y file:// no lo carga)
python3 -m http.server 8080   # → http://localhost:8080
```

Después pulsa **`F`** para pantalla completa y déjalo corriendo.

**Requisitos:** un navegador moderno con WebGL (Chrome, Edge o Firefox) y **conexión a internet**, porque Three.js se carga desde el CDN de jsDelivr.

---

## 🖥️ Modo servidor (opcional)

Sin parámetros, todo corre en el navegador como siempre. Con `?server=ws://host:puerto` la página deja de simular y **pinta lo que manda un servidor**: los drones, las misiones y el mapa vienen de un backend Node con base de datos. Es la base para inyectar telemetría real más adelante.

- **Base de datos:** PostgreSQL 17 + PostGIS + TimescaleDB (Docker). Guarda el escenario (rejilla OSM, alturas, fórmulas, zonas NFZ como polígonos) y la telemetría (hypertable).
- **Simulación en el servidor:** usa el mismo `sim-core.js` que el navegador, así que el enjambre se comporta igual que la demo.
- **Misiones:** ruta de waypoints validada contra las NFZ (PostGIS) y contra los edificios antes de lanzarla.
- **Telemetría externa:** `POST /ingest` o `WS /ingest` con `{droneId, lat, lon, alt_m, …}`; esos drones aparecen como `EXT-…`.

```bash
cp .env.example .env            # credenciales locales (no se suben al repo)
npm install
npm run db:up && npm run db:migrate
node tools/export-site.mjs      # altura + landmarks desde el frontend (Playwright)
npm run db:load
npm run server                  # → abre http://127.0.0.1:3000/ (el servidor también sirve la página)
```

En la consola C2: `mission demo`, `mission start`, `mission status`, `mission abort`. Arquitectura y plan: [`docs/architecture.md`](docs/architecture.md), [`docs/implementation-plan.md`](docs/implementation-plan.md). Tests: `npm test`. Toda la telemetría sigue siendo simulada salvo la que se inyecte por `/ingest`.

---

## 🎮 Controles de teclado y ratón

| Tecla / acción | Qué hace |
|---|---|
| **Clic en el suelo** | En `PATROL` inserta un waypoint prioritario. En los demás modos el enjambre pasa a **orbitar** ese punto. Cerca de un edificio, `ORBIT` se ajusta a ese landmark. |
| **Arrastrar / rueda** | 3D: rotar y hacer zoom con la cámara (OrbitControls). 2D: desplazar el mapa y hacer zoom |
| `1` `2` `3` `4` | Modo `PATROL` · `ORBIT` · `FORMATION` · `SCAN` |
| `C` | Alterna entre cámara orbital general y **cámara de persecución** del drone seleccionado |
| `V` | Alterna entre la vista **3D** (perspectiva) y la vista **2D** cenital: cámara ortográfica desde arriba, norte arriba, misma escena y mismo HUD. El minimapa marca la zona visible |
| `R` | **Fija la cámara**: sin auto-rotación (que por defecto es un barrido de ida y vuelta de ±45° alrededor de la vista, ver `sweep`) ni seguimiento del enjambre (otra vez `R` lo reactiva). En 2D, con seguimiento activo, el mapa se desplaza solo hacia el enjambre; `C` lo centra en el drone seleccionado |
| `Tab` | Con un segundo enjambre, alterna el enjambre seleccionado (A/B) |
| `A` | Activa o desactiva la rotación automática de modos (cada 50 s) |
| `H` | Oculta o muestra el HUD (queda solo la escena 3D) |
| `F` | Pantalla completa |
| `Enter` o `/` | Abre la terminal integrada para escribir comandos |
| `Esc` | Sale de la terminal |
| Clic en una celda de *Fleet Matrix* | Selecciona ese drone (cámara FPV, horizonte y telemetría) |
| **Botones en pantalla** (táctil/móvil) | `PATROL` `ORBIT` `FORM` `SCAN` · `A`/`B` (enjambre seleccionado, solo con BRAVO) · `CAM` (persecución) · `2D` (vista cenital) · `LOCK` (cámara fija) · `HUD` (oculta paneles y deja solo escena + barra superior) |

---

## 💻 Comandos de la terminal integrada

La franja inferior tiene dos paneles separados:

- **SYSTEM LOG**: eventos de la simulación y chatter de la flota. Filtros `ALL` / `EVENTS` (sin chatter) / `ALERTS` (solo avisos y errores). Al pasar el ratón por encima se **pausa** (`❚❚ PAUSED`) y se puede hacer scroll; al salir vuelve a `● LIVE`. Un clic en un `UAV-xx` lo pone en FOCUS UNIT y en el FPV.
- **C2 CONSOLE** (`c2@halcyon:~$`): la terminal. Pulsa `Enter` (o `/`), escribe y vuelve a pulsar `Enter`. Las respuestas salen aquí y no se pierden entre el chatter; los cambios con efecto (misión, flota, cámara…) también se anotan en el SYSTEM LOG. `Tab` autocompleta comandos y argumentos (dos `Tab` listan opciones), `↑`/`↓` recorren el historial y los botones de debajo lanzan comandos frecuentes (útiles en táctil).

| Comando | Ejemplo | Descripción |
|---|---|---|
| `help` | `help` | Lista los comandos |
| `drones=N` | `drones=40` · `drones 5` | Cambia **en caliente** el tamaño del enjambre (1–150). Los nuevos drones despegan escalonados y los sobrantes se retiran. |
| `mode=...` | `mode=orbit` · `mode scan` | `patrol`, `orbit`, `formation` o `scan` |
| `orbit=CODE` (`target=`) | `orbit=ago` · `orbit assut` | Lista landmarks con `orbit`; apunta por código, id o parte del nombre (sin distinguir acentos). Códigos: `pal`, `mus`, `umb`, `ago`, `ast`, `oce`. `orbit=hmf` se deniega por NFZ-A. |
| `quality=low\|high` | `quality=low` | `low` usa resolución 1x y desactiva el bloom (**más FPS**) |
| `name=TEXTO` | `name=Skynet` | Cambia el nombre del proyecto en la cabecera (máximo 24 caracteres) |
| `auto=on\|off` | `auto=off` | Rotación automática de modos |
| `view=2d\|3d` | `view=2d` | Vista cenital 2D o perspectiva 3D (igual que `V`) |
| `still=on\|off` | `still=on` | Cámara fija: sin giro ni seguimiento (igual que `R`) |
| `rotate=on\|off` · `follow=on\|off` | `rotate=off` | Auto-rotación de la cámara 3D y seguimiento del enjambre, por separado |
| `sweep=GRADOS` | `sweep=30` · `sweep=0` | Amplitud del barrido de la auto-rotación (±N°); `0` = giro completo de 360° |
| `swarm2=N\|off` | `swarm2=30` | Segundo enjambre BRAVO (1–80 drones) o lo retira |
| `role=friendly\|hostile` | `role=hostile` | BRAVO aliado o intrusos (ALPHA los intercepta) |
| `sel=a\|b` | `sel=b` | Enjambre que reciben `mode=`, `orbit=`, `1-4` y el clic (igual que `Tab`) |
| `status` | `status` | Resumen: drones activos, en RTB y cargando, modo, calidad y FPS |
| `clear` | `clear` · `clear=log` · `clear=all` | Limpia la consola, el SYSTEM LOG o ambos |

Tanto `drones=40` como `drones 40` son válidos. Cuando el navegador lo permite, los cambios de `drones`, `name` y `quality` se guardan en la URL, así que sobreviven a un F5. Con `file://` algunos navegadores lo bloquean; en ese caso usa un servidor local.

---

## 🔗 Parámetros por URL

Sirven para arrancar ya configurado:

```
index.html?name=SKYNET&drones=40&quality=low
```

| Parámetro | Por defecto | Descripción |
|---|---|---|
| `name` | `HALCYON` | Nombre del proyecto |
| `drones` | `60` (`30` en móvil/táctil) | Número de drones (1–150) |
| `quality` | `high` (`low` en móvil/táctil) | `low` para equipos modestos |
| `view` | `3d` | `2d` arranca en la vista cenital |
| `still` | — | `1` arranca con la cámara fija (equivale a `rotate=0&follow=0`) |
| `rotate`, `follow` | `1` | `0` desactiva la auto-rotación o el seguimiento del enjambre |
| `sweep` | `45` | Barrido de la auto-rotación en grados (`0` = 360°) |
| `swarm2` | `0` | Drones del segundo enjambre BRAVO (0 = apagado) |
| `role2` | `friendly` | `hostile` arranca BRAVO como intrusos |
| `embed` | — | `1` desactiva el zoom con rueda (para incrustarlo en un `<iframe>` sin bloquear el scroll de la página) |

---

## ⚡ Rendimiento

Si va lento:
1. `quality=low` en la terminal (el bloom es lo más costoso).
2. `drones=30` o menos.
3. `H` oculta el HUD, y con él también se deja de renderizar la cámara FPV (un render menos por frame).

La ciudad voxel usa instancias y es ligera en una GPU: unos 38.000 cubos de landmarks y 9.000 cajas de ciudad. El render por software/WebGL sin GPU (por ejemplo, en pruebas headless) es mucho más lento. El contador de FPS está arriba a la derecha y también sale en `status`.

---

## 📱 Responsive

El HUD se reorganiza según el tamaño y la orientación de la pantalla:

| Pantalla | Distribución |
|---|---|
| **Horizontal** (escritorio, portátil) | Columnas laterales (estado/flota · mapa/FPV/foco), escena en el centro y log + telemetría abajo. Las columnas se estrechan en pantallas pequeñas y los paneles se compactan en alturas ≤ 860 px. |
| **Monitor vertical / tablet vertical** | Escena arriba a todo el ancho y paneles en una banda inferior de 3 columnas (estado/flota · mapa/telemetría · FPV/foco), con log y consola a todo el ancho al final. |
| **Móvil vertical** | Barra compacta, 6 indicadores en una fila, escena con minimapa en la esquina, botones táctiles, log corto y consola de una línea. |
| **Móvil horizontal** | Escena, mapa lateral y botones táctiles. |

La cámara 3D **se reencuadra sola** en la zona que queda libre: centra la proyección con `camera.setViewOffset`, ajusta el FOV al ancho disponible y, si la zona es alta y estrecha, se aleja y se vuelve más cenital. Así los paneles nunca tapan la ciudad.

## 🧩 Qué se ve en pantalla

```
┌──────────────────────────── PROJECT X // AUTONOMOUS SWARM C2 ── MODE ── UTC ── T+ ── FPS ─┐
│ SWARM STATUS  │                                              │ TACTICAL MAP (radar,       │
│ (activos, RTB,│                                              │ cobertura, NFZ, rutas)     │
│ carga, bat,   │            ESCENA 3D (Three.js)              ├────────────────────────────┤
│ link, cober.) │   Valencia en vóxeles · drones · NFZ · base  │ FPV FEED (cámara del drone)│
├───────────────┤                                              ├────────────────────────────┤
│ FLEET MATRIX  │                                              │ FOCUS UNIT (horizonte      │
│ (bat/estado   │                                              │ artificial + telemetría)   │
│ por drone)    │                                              │                            │
├───────────────┴─────────────────┬────────────────────────────┼────────────────────────────┤
│ SYSTEM LOG (filtros, pausa)     │ C2 CONSOLE (comandos)      │ TELEMETRY (THRPT/ALT/LAT)  │
└─────────────────────────────────┴────────────────────────────┴────────────────────────────┘
```

- **Escena 3D**: los edificios de la Ciutat de les Arts i les Ciències y la ciudad de Valencia se representan con vóxeles y una retícula luminosa. Hay balizas rojas en lo alto de cada landmark y de las 14 torres urbanas más altas (≥ 60 m), dos zonas NFZ, base de carga con plataformas y drones con LEDs de estado, estroboscopio y estelas.
- **Drone seleccionado**: anillo, cono de escaneo al suelo y etiqueta flotante. Cambia cada 10 s.
- **Banner** “RETASKING SWARM” cada vez que cambia la misión.

## 🛸 Segundo enjambre (BRAVO)

Opcional y apagado por defecto: `swarm2=N` en la terminal o en la URL (1–80 drones).

- **BRAVO aliado** (naranja, `BRV-xx`): base propia al noreste del Oceanogràfic (≈ 39.45458, −0.34602), misiones independientes de ALPHA (la auto-rotación de modos evita que ambos vuelen el mismo modo) y rombos naranjas en el mapa. `Tab`, el botón `A/B` o `sel=a|b` eligen a qué enjambre van `1-4`, `mode=`, `orbit=` y el clic en el suelo; la cabecera marca el seleccionado con `▸`.
- **BRAVO hostil** (`role=hostile`, rojo, `TRK-xx`): intrusos que ignoran el geofence (el log avisa de cada `GEOFENCE BREACH`) y van en tres grupos hacia landmarks o la base ALPHA. Hasta el 40 % de ALPHA se separa para interceptarlos (líneas rojas discontinuas); un interceptor que se mantiene a menos de 20 m durante 3 s obliga al intruso a volver a su base (`NEUTRALIZED`), donde recarga y vuelve a despegar. Los intrusos no se pueden comandar y no cuentan en las estadísticas de la flota.
- Separación entre ambos enjambres siempre activa; alineación y cohesión solo dentro de cada uno.

## 🏛️ El escenario: Ciutat de les Arts i les Ciències

La simulación se sitúa en el complejo de Valencia y su entorno urbano real. Las siluetas de Calatrava y Candela se generan con fórmulas implícitas de forma en el espacio, `f(u, v, z, T) → material`, definidas en `cac-shapes.js`. Ese archivo se genera desde el proyecto complementario del autor `calatrava-voxels`. En el arranque se muestrean en una rejilla compartida de cubos de 2 m (3 m en móviles/táctiles); solo se dibujan los cubos con algún vecino vacío. Son unos 38.000 cubos de superficie, un `InstancedMesh` por edificio y unos 60 ms de muestreo. Primero asciende la ciudad y luego cada landmark se imprime capa a capa; el log registra `SITE MODEL: … voxels @ 2 m`.

| Código | Edificio | Arquitecto / año |
|---|---|---|
| `PAL` (`pal`) | Palau de les Arts Reina Sofía | Santiago Calatrava, 2005 |
| `HMF` (`hmf`) | L'Hemisfèric (NFZ-A) | Santiago Calatrava, 1998 |
| `MUS` (`mus`) | Museu de les Ciències | Santiago Calatrava, 2000 |
| `UMB` (`umb`) | L'Umbracle | Santiago Calatrava, 2001 |
| `AGO` (`ago`) | L'Àgora | Santiago Calatrava, 2009 |
| `AST` (`ast`) | Pont de l'Assut de l'Or | Santiago Calatrava, 2008 |
| `OCE` (`oce`) | L'Oceanogràfic: Restaurant Submarí, Edifici d'Accés, aviario Aiguamolls y Àrtic | Félix Candela, 2003 (conchas y cúpulas) |

El entorno se basa en **OpenStreetMap**. `tools/osm-city.py` descarga datos de Overpass (solo usa la biblioteca estándar de Python) y los rasteriza en dos cuadrículas de 550×550 celdas de 4 m (2,2 km de lado): unos 19.000 edificios, con altura de `height` o `building:levels` × 3,1 m, y coberturas de suelo (parques, árboles, agua/piscinas, carreteras, vías y arena). Los edificios ya modelados con fórmulas se excluyen. Los datos se empaquetan con gzip + base64 en `assets/valencia-city.js` (~60 KB); el navegador los decodifica con `DecompressionStream('gzip')`. Las celdas de igual altura se fusionan en unas 9.000 cajas alargadas y las coberturas se dibujan como textura pixelada del suelo. La cuadrícula gira −40,5° para alinearse con el complejo.

- **Base**: las plataformas de despegue están en el Jardí del Túria, al noreste del Museu (≈ 39.45688, −0.35040).
- **Estación RTK-GNSS**: mástil y baliza verdes, con un rombo en el mapa, en el pin 39.457442, −0.355547 (piscina frente al Palau de les Arts).
- **Geofence**: NFZ-A es un radio de 92 m y 220 m de altura sobre L'Hemisfèric; sus vóxeles se tiñen de rojo y no se permite orbitarlo. NFZ-B es una restricción temporal aleatoria (TFR).
- **Escala y coordenadas**: el marco del sitio usa metros, X hacia el este e Y hacia el norte; su origen es 39.45472, −0.3525, con proyección equirectangular. La cuadrícula OSM gira −40,5° alrededor de la base. En la escena, X apunta al este y Z al sur; 1 unidad de escena = 2 m. El área operativa es ±280 unidades (±560 m). ALT, SPD, telemetría, log y cursor E/N se muestran en metros; LAT/LON son las coordenadas reales del drone.
- **Mapa**: fondo OSM con edificios por altura y coberturas, huellas CAC resaltadas, códigos `PAL`, `MUS`, `UMB`, `AGO`, `AST`, `OCE`, círculos NFZ, rombo RTK y rejilla cada 100 m; indica `R 560m` y `© OpenStreetMap`.

**Datos:** © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.

Para regenerar los datos derivados: `python3 tools/sync-cac.py` y `python3 tools/osm-city.py`. Para descargar datos OSM nuevos, elimina `tools/.cache/osm-city.json` antes de ejecutar el segundo comando.

---

## 🛠️ Cómo se hizo (referencia técnica)

### Stack
- **Sin build**: `index.html` más dos scripts de datos planos (`cac-shapes.js` y `assets/valencia-city.js`); sin bundler ni `npm install`. Se puede abrir con doble clic (`file://`).
- **Three.js r160** vía `importmap` desde jsDelivr.
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
| **Evitación** | Empuje radial desde NFZ y obstáculos; consulta un mapa de alturas y trepa o se desliza para evitar choques |
| **Límites** | Altitud de 14–100 unidades (28–200 m) y área operativa de ±280 unidades (±560 m) |

El mapa de alturas guarda la parte superior de lo que ocupa cada celda de 4 m (ciudad + vóxeles CAC). Cada drone mira hacia delante según su velocidad (0,4/0,8/1,3 s), trepa si hay algo en el camino y sondea 8 direcciones a 14 m para deslizarse alrededor de paredes. Los objetivos de misión se elevan sobre los obstáculos.

Los pesos cambian según el modo (`MODE_W`):

| Modo | Comportamiento | Cómo se calcula el goal |
|---|---|---|
| `PATROL` | Flocking clásico (alineación y cohesión altas) | Waypoint actual más un offset por drone. Cuando el centroide llega a menos de 30 m, pasa al siguiente. Al acabar la ruta se genera otra. |
| `ORBIT` | Anillos alrededor de un landmark, con radio y altura ajustados al edificio; el puente se orbita sobre el abanico de cables | `centro + (cos a·R, alt, sin a·R)` con fase repartida por *slot*. Un clic cerca de un landmark lo selecciona. |
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
- **Vóxeles**: material Lambert parcheado con `onBeforeCompile`; las líneas de la retícula luminosa siguen la cuadrícula propia de cada malla (incluida en cajas urbanas estiradas: una celda de 4 m y una línea de planta cada 3,1 m). `uReveal` controla una altura de revelado para el efecto de arranque. En `quality=low`, sin bloom, la retícula brilla más.
- **Instancing**: un `InstancedMesh` por edificio CAC, más cajas urbanas fusionadas por altura.
- **Bloom** (`UnrealBloomPass`) para el look de neón. Se desactiva con `quality=low`.
- **Cámara FPV**: se renderiza la misma escena una segunda vez con otra cámara, usando `setViewport` y `setScissor` sobre el rectángulo del panel FPV. Ese panel no tiene fondo ni blur para que se vea el render de debajo. Durante ese render se ocultan el drone y sus marcadores.
- **Estelas**: `THREE.Line` con buffer circular de 40 puntos, colores degradados y `AdditiveBlending`.
- Plataformas de carga con `InstancedMesh`, que se reconstruye al cambiar el número de drones.

### 4. HUD y datos
- **Mapa táctico**: base OSM, edificios por altura, huellas CAC, coberturas del suelo, códigos de landmarks, NFZ, baliza RTK, rejilla de 100 m y etiqueta `R 560m`; además muestra barrido de radar, ruta y waypoints, drones por color de estado y un **mapa de cobertura**. La rejilla es de 24×24 celdas; una celda cuenta como cubierta si un drone activo pasó por ella en los últimos 90 s. Ese valor es el % de COVERAGE, que se calcula de verdad. Incluye `© OpenStreetMap`.
- **Telemetría del drone seleccionado**:
  - ALT, SPD, HDG, BAT y LINK se calculan en la simulación y se presentan en unidades reales; RPM y temperatura del ESC son derivados.
  - LAT/LON son las coordenadas reales de la posición, desde el origen del sitio (39.45472, −0.3525) mediante proyección equirectangular. El cursor muestra E/N en metros.
- **Log**: mensajes de arranque y eventos de la simulación (RTB, aterrizajes, waypoints, geofence, cambios de modo), además de chatter procedural sobre la flota y líneas SURVEY/LIDAR del landmark más cercano. El chatter lleva la clase `chat` para que el filtro `EVENTS` lo oculte por CSS.
- El HUD de texto se actualiza cada 250 ms. El mapa y el horizonte se dibujan en cada frame.
- El layout se adapta a la altura de la pantalla: el mapa y el FPV escalan con `vh`.

### 5. Terminal interactiva
Es un `<input>` en el panel C2 CONSOLE. `runCmd()` activa `toConsole` para que `log()` escriba en la consola (y copie `ok`/`sys`/`warn` al SYSTEM LOG) y `execCmd()` parsea `comando[=| ]argumento`. El autocompletado usa la tabla `CMD_ARGS`. `setDroneCount()` hace lo siguiente:
- Libera los drones sobrantes (`dispose()` de materiales y geometrías).
- Reconstruye las plataformas y reasigna la plataforma de cada drone.
- Crea los nuevos drones con despegue escalonado.
- Regenera el panel *Fleet Matrix*.

La terminal también resuelve objetivos de órbita por código, id o nombre parcial; `orbit` lista los landmarks y rechaza objetivos dentro de NFZ-A. Los atajos de teclado se ignoran mientras escribes en la terminal.

### 6. Cómo se verificó
- `node --check` sobre el script extraído (sintaxis).
- **Playwright + Chromium con SwiftShader**: capturas a 1920×1080, 1440×810 embebido (`?embed=1&quality=low&drones=45`), 1080×1920 y 390×844; sin errores de consola.
- Prueba de estrés con 150 drones y 60 s de tiempo simulado por modo: 0 incursiones en NFZ y aproximadamente 0 contactos con estructuras (unas pocas muestras rozaron los cables del puente).
- El bucle separa `simStep(dt)` de la representación. `window.__swarm` expone drones, landmarks, obstáculos, `topAt`, `setMode`, `runCmd` y `warp(seconds)` para avanzar la simulación sin renderizar.

### 7. Cómo se generó el GIF
El render por software de un navegador headless va a ~4 FPS, así que se usa **`page.clock` de Playwright** (tiempo virtual). El script avanza el reloj 1/12 s, hace una captura y repite, de modo que la animación sale fluida sin depender del rendimiento real. Script: [`tools/record-gif.mjs`](tools/record-gif.mjs).

```bash
npm i --no-save playwright gifsicle && npx playwright install chromium
node tools/record-gif.mjs                                   # → frames/*.png (1280x720, 12 fps)

# GIF (paleta optimizada + compresión con pérdida → ~6 MB)
ffmpeg -framerate 12 -i frames/f%04d.png -vf "fps=8,scale=720:-1:flags=lanczos,palettegen=max_colors=64:stats_mode=diff" pal.png
ffmpeg -framerate 12 -i frames/f%04d.png -i pal.png -lavfi "fps=8,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" tmp.gif
npx gifsicle -O3 --lossy=160 --colors 48 tmp.gif -o assets/demo.gif

# MP4 en mejor calidad
ffmpeg -framerate 12 -i frames/f%04d.png -vf scale=1280:-2 -c:v libx264 -pix_fmt yuv420p -crf 28 -movflags +faststart assets/demo.mp4
```

Durante la grabación se ocultan las scanlines (`#fx`), porque el patrón de líneas hace que el GIF pese varias veces más.

---

## 🔧 Dónde tocar para personalizar

La lógica está en `index.html`, en el `<script type="module">` (los datos del escenario, en `cac-shapes.js` y `assets/valencia-city.js`):

| Qué | Dónde |
|---|---|
| Velocidad, fuerza y radios de vecinos | `const MAXS, MAXF, R_NEI, R_SEP` en `CONFIG` |
| Pesos de flocking por modo | `const MODE_W` |
| Colores por estado | `STATE_COLOR` y variables CSS `:root` (`--c`, `--g`, `--y`, `--r`) |
| Cada cuánto cambia de modo | `modeTimer > 50` en el loop principal |
| Cada cuánto cambia el drone seleccionado | `focusTimer > 10` |
| Descarga y carga de batería | `this.drain = rand(...)` · `dt * 8` · `battery < 15` |
| Sitio, escala y área | `SC`, `AREA`, `VOX`, `PIN` en `CONFIG` / `SITE: VALENCIA` |
| NFZ | `addNfz` en el bloque `SITE` |
| Colores de los vóxeles | `VCOL` y `voxMaterial` |
| Datos de la ciudad OSM | `tools/osm-city.py`: `BASE`, `THETA`, `CELL`, `N` |
| Mensajes del log | array `gen` en `chatter()` y array `boot` |
| Nuevos comandos de terminal | `switch (cmd)` en `runCmd()` |

---

## 💡 Ideas para más adelante
- Relieve real del cauce del Túria (el jardín está ~6 m por debajo de la calle).
- Modo **realidad aumentada** con webcam y MediaPipe (hand/face tracking) en un panel.
- Tráfico aéreo real (ADS-B) en el mapa.
- Incluir Three.js en local (`vendor/`) para que funcione sin internet.
- Rejilla espacial para los vecinos de boids y así soportar más de 500 drones.
- Tema de color configurable (`theme=amber`, `theme=green`).

---

## 📁 Estructura

```
drone-swarm-c2/
├── .gitignore             # excluye tools/.cache/
├── index.html            # app (HTML + CSS + JS)
├── sim-core.js           # simulación compartida navegador/servidor (boids, misiones)
├── net-client.js         # cliente WebSocket/REST del modo servidor
├── cac-shapes.js         # fórmulas voxel de edificios CAC (generado)
├── server/               # backend Node (Fastify, WebSocket, PostGIS/TimescaleDB, tests)
├── docker-compose.yml    # base de datos local
├── docs/                 # arquitectura y plan de implementación
├── assets/
│   ├── valencia-city.js  # datos OSM rasterizados (generado)
│   ├── demo.gif          # GIF del README
│   ├── demo.mp4          # vídeo en mejor calidad
│   └── screenshot.png
├── tools/
│   ├── osm-city.py       # descarga y rasteriza los datos OSM
│   ├── sync-cac.py       # sincroniza las fórmulas del proyecto companion
│   └── record-gif.mjs    # grabación de la demo con Playwright (reloj virtual)
├── README.md             # documentación (español)
└── README.en.md          # documentation (English)
```
