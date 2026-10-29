#!/usr/bin/env python3
"""Bake the real surroundings of Valencia's Ciutat de les Arts i les Ciències from OpenStreetMap
into two small rasters that the dashboard renders as coarse voxels:

  * h  - building height in metres per cell (uint8)      -> city blocks + collision height map
  * c  - land cover class per cell (uint8, see COVER)    -> ground texture (park, water, roads...)

The grid is a square of N x N cells of CELL metres, centred on the drone base and rotated so its
u axis follows the complex (the Calatrava buildings and the street grid around them run along it).
The buildings that the dashboard draws from formulas (cac-shapes.js) are left out of h.

Output: assets/valencia-city.js  ->  window.CITY = { ..., h: base64(gzip), c: base64(gzip) }
Usage:  python3 tools/osm-city.py [--site cac|levante]   (downloads tools/.cache/osm-<site>.json if missing)
Only the Python standard library is needed. Data (c) OpenStreetMap contributors, ODbL.
"""
import base64, gzip, json, math, os, re, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R_EARTH = 6371008.8
# One entry per dashboard site (see sites.js). origin = lat, lon of the site frame used by the shapes file
# (x east, y north, m); base = drone base in that frame; theta = grid u axis, ccw from east.
SITES = {
    'cac': dict(cache='osm-city.json', out='valencia-city.js', shapes='cac-shapes.js', title='the Ciutat de les Arts i les Ciències',
                origin=(39.45472, -0.35250), base=(180.0, 240.0), theta=-40.5),     # base: Jardí del Túria, NE of the Museu
    'levante': dict(cache='osm-levante.json', out='levante-city.js', shapes='lev-shapes.js', title="the Estadi Ciutat de València (Orriols)",
                    origin=(39.49472, -0.36390), base=(302.0, 122.0), theta=-15.0),  # base: open ground N of the Ronda Nord, NE of the stadium (88 m clear square, tools/find-base); theta: stadium axes (75 deg)
}
SITE_ID = sys.argv[sys.argv.index('--site') + 1] if '--site' in sys.argv else 'cac'
if SITE_ID not in SITES:
    sys.exit(f'unknown site {SITE_ID!r}; one of {", ".join(SITES)}')
_S = SITES[SITE_ID]
CACHE = os.path.join(ROOT, 'tools', '.cache', _S['cache'])
OUT = os.path.join(ROOT, 'assets', _S['out'])
SHAPES = os.path.join(ROOT, _S['shapes'])
ORIGIN = _S['origin']
BASE = _S['base']
THETA = math.radians(_S['theta'])
CELL = 4.0                         # metres per cell
N = 550                            # cells per side -> 2.2 km
HALF = N * CELL / 2

COVER = {'paved': 0, 'grass': 1, 'trees': 2, 'water': 3, 'road': 4, 'street': 5, 'rail': 6, 'sand': 7}
ROAD_W = {'motorway': 22, 'trunk': 20, 'primary': 16, 'secondary': 13, 'tertiary': 10, 'motorway_link': 8,
          'trunk_link': 8, 'primary_link': 8, 'secondary_link': 7, 'residential': 7, 'unclassified': 7,
          'living_street': 6, 'pedestrian': 6, 'service': 4}
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link'}


def to_site(lat, lon):
    lat0, lon0 = ORIGIN
    return (math.radians(lon - lon0) * R_EARTH * math.cos(math.radians(lat0)), math.radians(lat - lat0) * R_EARTH)


def to_site_inv(x, y):
    lat0, lon0 = ORIGIN
    return (lat0 + math.degrees(y / R_EARTH), lon0 + math.degrees(x / (R_EARTH * math.cos(math.radians(lat0)))))


C, S = math.cos(THETA), math.sin(THETA)


def to_grid(x, y):
    """site metres -> continuous cell coordinates (gi, gj); cell (i, j) spans [i, i+1) x [j, j+1)."""
    dx, dy = x - BASE[0], y - BASE[1]
    u, v = dx * C + dy * S, -dx * S + dy * C
    return (u + HALF) / CELL, (v + HALF) / CELL


def fetch():
    corners = [(BASE[0] + su * HALF * C - sv * HALF * S, BASE[1] + su * HALF * S + sv * HALF * C)
               for su in (-1, 1) for sv in (-1, 1)]
    lats, lons = zip(*[to_site_inv(x, y) for x, y in corners])
    bb = f'{min(lats):.6f},{min(lons):.6f},{max(lats):.6f},{max(lons):.6f}'
    q = f"""[out:json][timeout:180];
(
 way["building"]({bb}); relation["building"]({bb}); way["building:part"]({bb});
 way["leisure"~"park|garden|pitch|playground|swimming_pool"]({bb}); relation["leisure"~"park|garden"]({bb});
 way["landuse"~"grass|forest|meadow|recreation_ground|village_green|farmland|orchard"]({bb});
 way["natural"~"water|wood|scrub|sand"]({bb}); relation["natural"="water"]({bb}); way["water"]({bb});
 way["highway"~"{'|'.join(ROAD_W)}"]({bb});
 way["railway"~"rail|tram|light_rail"]({bb});
);
out geom;"""
    req = urllib.request.Request(os.environ.get('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'), data=urllib.parse.urlencode({'data': q}).encode(),
                                 headers={'User-Agent': 'drone-swarm-c2 osm-city.py'})
    data = urllib.request.urlopen(req, timeout=240).read()
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    open(CACHE, 'wb').write(data)


# ---------------------------------------------------------------- geometry helpers
def rings_of(el):
    """closed rings (lists of grid points) of a way or multipolygon relation (outer + inner, even-odd)."""
    if el['type'] == 'way':
        g = el.get('geometry') or []
        return [[to_grid(*to_site(p['lat'], p['lon'])) for p in g]] if len(g) > 2 else []
    rings = []
    for m in el.get('members', []):
        g = m.get('geometry') or []
        if m.get('type') == 'way' and len(g) > 2 and m.get('role') in ('outer', 'inner'):
            rings.append([to_grid(*to_site(p['lat'], p['lon'])) for p in g])
    return rings


def fill(rings, cb):
    """call cb(i, j) for every cell whose centre is inside the rings (even-odd scanline)."""
    pts = [p for r in rings for p in r]
    if not pts:
        return
    j0, j1 = max(0, int(min(p[1] for p in pts))), min(N - 1, int(max(p[1] for p in pts)))
    edges = [(r[k], r[(k + 1) % len(r)]) for r in rings for k in range(len(r))]
    for j in range(j0, j1 + 1):
        yc, xs = j + 0.5, []
        for (ax, ay), (bx, by) in edges:
            if (ay <= yc) != (by <= yc):
                xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
        xs.sort()
        for a, b in zip(xs[::2], xs[1::2]):
            for i in range(max(0, math.ceil(a - 0.5)), min(N - 1, math.floor(b - 0.5)) + 1):
                cb(i, j)


def stroke(pts, width_m, cb):
    """call cb(i, j) for every cell centre within width/2 of the polyline."""
    r = width_m / 2 / CELL
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        for j in range(max(0, int(min(ay, by) - r)), min(N - 1, int(max(ay, by) + r)) + 1):
            for i in range(max(0, int(min(ax, bx) - r)), min(N - 1, int(max(ax, bx) + r)) + 1):
                px, py = i + 0.5 - ax, j + 0.5 - ay
                t = max(0, min(1, (px * dx + py * dy) / L2))
                if (px - t * dx) ** 2 + (py - t * dy) ** 2 <= r * r:
                    cb(i, j)


def inside(pt, poly):
    x, y, c = pt[0], pt[1], False
    for k in range(len(poly)):
        (ax, ay), (bx, by) = poly[k], poly[k - 1]
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            c = not c
    return c


def num(s):
    m = re.match(r'\s*([0-9]+(?:[.,][0-9]+)?)', s or '')
    return float(m.group(1).replace(',', '.')) if m else None


def height_of(t):
    h = num(t.get('height'))
    if h is None and num(t.get('building:levels')) is not None:
        h = num(t['building:levels']) * 3.1 + 1.5 + 2.0 * (num(t.get('roof:levels')) or 0)
    return h


# ---------------------------------------------------------------- main
def main():
    if not os.path.exists(CACHE):
        print('downloading from Overpass…')
        fetch()
    els = json.load(open(CACHE))['elements']
    shapes = open(SHAPES, encoding='utf-8').read()
    site = json.loads(re.search(r'/\*SITE-DATA\*/(.*?)/\*END-SITE-DATA\*/', shapes, re.S).group(1))
    cac = [[to_grid(x, y) for x, y in fp] for fp in site['footprints'].values()]

    H = bytearray(N * N)
    Cv = bytearray(N * N)
    def setc(k):
        def cb(i, j): Cv[j * N + i] = k
        return cb

    # 1) land cover (order = priority: later wins)
    layers = {'grass': [], 'trees': [], 'sand': [], 'water': [], 'street': [], 'road': [], 'rail': []}
    for el in els:
        t = el.get('tags', {})
        if 'building' in t or 'building:part' in t:
            continue
        if 'highway' in t:
            hw = t['highway']
            if hw in ROAD_W and t.get('tunnel') not in ('yes', 'building_passage') and t.get('layer', '0') >= '0':
                layers['road' if hw in MAJOR else 'street'].append((el, ROAD_W[hw]))
        elif 'railway' in t:
            if t.get('tunnel') != 'yes':
                layers['rail'].append((el, 3))
        elif t.get('natural') == 'water' or 'water' in t or t.get('leisure') == 'swimming_pool':
            layers['water'].append((el, 0))
        elif t.get('natural') in ('wood', 'scrub') or t.get('landuse') in ('forest', 'orchard'):
            layers['trees'].append((el, 0))
        elif t.get('natural') == 'sand' or t.get('leisure') in ('pitch', 'playground'):
            layers['sand'].append((el, 0))
        elif t.get('leisure') in ('park', 'garden') or t.get('landuse'):
            layers['grass'].append((el, 0))
    for name in ('grass', 'trees', 'sand', 'water', 'street', 'road', 'rail'):
        for el, w in layers[name]:
            if w:
                g = el.get('geometry') or []
                stroke([to_grid(*to_site(p['lat'], p['lon'])) for p in g], w, setc(COVER[name]))
            else:
                fill(rings_of(el), setc(COVER[name]))

    # 2) buildings: max height per cell; skip the ones drawn from formulas, and outlines that have parts
    blds, parts = [], []
    for el in els:
        t = el.get('tags', {})
        if 'building:part' in t:
            parts.append(el)
        elif 'building' in t:
            blds.append(el)
    def centroid(rings):
        pts = rings[0]
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    def is_cac(rings):
        pts = rings[0]
        k = sum(any(inside(p, fp) for fp in cac) for p in pts)
        return any(inside(centroid(rings), fp) for fp in cac) or k > len(pts) / 2
    part_items = [(r, el) for el in parts for r in [rings_of(el)] if r]
    part_cent = [centroid(r) for r, _ in part_items]
    n_b = n_skip = 0
    for el in blds + parts:
        rings = rings_of(el)
        if not rings:
            continue
        if is_cac(rings):
            n_skip += 1
            continue
        t = el['tags']
        h = height_of(t)
        if 'building' in t and 'building:part' not in t and h is None:
            if any(inside(c, rings[0]) for c in part_cent):
                continue                               # the parts carry the heights
        if h is None:
            h = {'roof': 5, 'garage': 4, 'shed': 3, 'kiosk': 3, 'service': 4, 'hut': 3}.get(t.get('building'), 12)
        if t.get('building') == 'roof':
            h = min(h, 6)
        h = int(max(2, min(250, round(h))))
        n_b += 1
        def cb(i, j, h=h):
            k = j * N + i
            if H[k] < h:
                H[k] = h
        fill(rings, cb)

    b64 = lambda b: base64.b64encode(gzip.compress(bytes(b), 9, mtime=0)).decode()
    data = {
        'origin': list(ORIGIN), 'base': list(BASE), 'theta': round(math.degrees(THETA), 3), 'cell': CELL, 'n': N,
        'cover': COVER, 'h': b64(H), 'c': b64(Cv),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    js = (f'// Surroundings of {_S["title"]}, baked by tools/osm-city.py --site {SITE_ID}.\n'
          '// Map data (c) OpenStreetMap contributors, ODbL 1.0 - https://www.openstreetmap.org/copyright\n'
          'window.CITY = ' + json.dumps(data, separators=(',', ':')) + ';\n')
    open(OUT, 'w').write(js)
    filled = sum(1 for v in H if v)
    print(f'buildings {n_b} (skipped {n_skip} drawn from formulas) · built cells {filled} '
          f'({filled / N / N * 100:.1f}%) · max {max(H)} m · {os.path.getsize(OUT) / 1024:.1f} KB -> {OUT}')


if __name__ == '__main__':
    main()
