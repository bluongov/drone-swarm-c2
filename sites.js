// sites.js · registry of the dashboard sites (browser + Node). Plain data, no DOM.
// A site = a real place: an OSM raster around the drone base (city: window.CITY, tools/osm-city.py --site <id>)
// plus a set of buildings written as formulas (shapes: a classic script setting window[shapesGlobal], synced from
// ../voxel-maps/<project> by tools/sync-*.py). Pick one with ?site=<id> (offline) or SITE_ID=<id> (server).
// Coordinates: scene units (1 unit = 2 m), X east, Z south, origin = ALPHA drone base (CITY.base).

export const DEFAULT_SITE = 'cac';

export const SITES = {
  cac: {
    id: 'cac',
    name: 'Ciutat de les Arts i les Ciències',
    short: 'Ciutat',
    city: 'assets/valencia-city.js',
    shapes: 'cac-shapes.js', shapesGlobal: 'CAC',
    skip: [],                                            // formula ids not drawn (none here)
    // formula id → [map code, display name]; ids sharing a code in `merge` become one landmark
    landmarks: {
      palau: ['PAL', 'Palau de les Arts'], hemisferic: ['HMF', "L'Hemisfèric"], museu: ['MUS', 'Museu de les Ciències'],
      umbracle: ['UMB', "L'Umbracle"], agora: ['AGO', "L'Àgora"], assut: ['AST', "Pont de l'Assut de l'Or"],
      submari: ['OCE', "L'Oceanogràfic"], acces: ['OCE'], aviari: ['OCE'], artic: ['OCE'],
    },
    merge: { OCE: { id: 'oceanografic', name: "L'Oceanogràfic" } },
    centroid: [],                                        // ids whose landmark centre = voxel centroid instead of place
    radius: { assut: 10 },                               // landmark radius override (scene units)
    orbitAbove: ['assut'],                               // orbit above the top (bridge pylon) instead of around it
    noOrbit: [],                                         // landmarks never picked as orbit targets
    labelDy: { assut: -6 },                              // tactical map label nudge (px)
    nfz: { hemisferic: { r: 46, h: 110, label: "L'HEMISFÈRIC" } },
    rtk: [39.457442, -0.355547], rtkNote: 'pool in front of the Palau',
    baseName: 'Jardí del Túria', baseBName: 'next to the Oceanogràfic',
    baseB: [188, 128],                                   // BRAVO base (scene x, z): open ground NE of the Oceanogràfic
    camera: { pos: [110, 140, -180], target: [-50, 20, 60] },
    center2d: [-20, 57],
  },
  levante: {
    id: 'levante',
    name: 'Estadi Ciutat de València · Orriols',
    short: 'Levante',
    city: 'assets/levante-city.js',
    shapes: 'lev-shapes.js', shapesGlobal: 'LEV',
    skip: ['barri'],                                     // the neighbourhood comes from the OSM raster instead
    landmarks: {
      estadi: ['EST', 'Estadi Ciutat de València'], arena: ['ARE', 'Centre Comercial Arena'],
      oficines: ['OFI', 'Edifici Arena'], torre: ['TOR', 'Torre Orriols'], cotxera: ['MET', 'Tallers Machado (Metrovalència)'],
      parroquia: ['PAR', 'Parròquia del Sagrat Cor'], camp: ['CMP', 'Camp de Futbol Orriols'], parc: ['PRC', "Parc d'Orriols"],
    },
    merge: {},
    centroid: ['arena', 'parc'],                         // the mall wraps the stadium; the park formula is placed at the origin
    radius: {},
    orbitAbove: [],
    noOrbit: ['arena'],                                  // the mall's centroid sits on the stadium NFZ edge
    labelDy: {},
    nfz: { estadi: { r: 56, h: 110, label: 'ESTADI CIUTAT DE VALÈNCIA' } },
    rtk: [39.49532, -0.36251], rtkNote: 'roof of the Edifici Arena',
    baseName: 'Horta, north of the Ronda Nord', baseBName: 'in the Horta fields',
    baseB: [-107, -126],                                 // open ground in the Horta north of the depot (site 88, 374 m)
    camera: { pos: [60, 150, -170], target: [-140, 15, 60] },
    center2d: [-70, 40],
  },
};

export function getSite(id) { return SITES[id] || null; }
