/**
 * BI 3D Spatial Recruitment Engine (`Almukayman/Zone_D` Architectural Digital Twin Style)
 * Standalone Three.js ES Module for Northern Vietnam Industrial Parks (Level 1),
 * KCN Zone Master-Plan Compounds (Level 2), and 3D Factory Compounds & 4-Side Orbit (Level 3).
 *
 * Upgraded with:
 *  1. BI Skin-Aware Bright 3D Theme (`setSkinTheme(skinId, skinTokens)`) for all 6 BI light skins
 *  2. Real Geographic Map Tile Draping (`/api/map-tile?style=street|satellite`) on Level 1 Macro Map
 *     & Level 2/3 High-Zoom (`zoom=15`) KCN Polygon Pads (`setMapStyle('street' | 'satellite')`)
 *  3. Realistic 3D Miniature Cars, 45-Seat Worker Shuttle Buses & Motorbikes with Riders
 */
import * as THREE from 'three';
import * as GeoAdapter from './spatial-adapter.js';

const SIDE_ORDER = ['south', 'east', 'north', 'west'];

const SIDE_VECTORS = {
  south: { x: 0.18, z: 1.0 },
  east: { x: 1.0, z: 0.16 },
  north: { x: -0.18, z: -1.0 },
  west: { x: -1.0, z: -0.16 },
};

/**
 * Canonical 3D architectural daylight themes synchronized with BI's 6 light skins
 */
export const SKIN_3D_THEMES = Object.freeze({
  'hr-partner': {
    id: 'hr-partner',
    name: 'HR Partner',
    skyBg: 0xf7efe8,
    fogColor: 0xf2e8df,
    hemiSky: 0xfffaf5,
    hemiGround: 0xb8a99a,
    tableBase: 0xdccbb8,
    tableTop: 0xf4ece4,
    plateauTop: 0xede2d7,
    plateauSide: 0xc4ae98,
    kcnPadBase: 0xebe5df,
    kcnApron: 0xdcd3ca,
    plotPad: 0xd6cdc4,
    primary: 0xc2410c,
    primaryDark: 0x7c2d12,
    accent: 0xea580c,
    emeraldHighlight: 0x16a34a,
    kcnActiveBorder: 0xea580c,
    hoverAccent: 0xc2410c,
    waterColor: 0x38bdf8,
    waterEmissive: 0x0284c7,
  },
  'royal-navy': {
    id: 'royal-navy',
    name: 'Royal Navy',
    skyBg: 0xeaf0fa,
    fogColor: 0xe3ebf7,
    hemiSky: 0xf8fbff,
    hemiGround: 0x9aaac2,
    tableBase: 0xc3d1e6,
    tableTop: 0xe8eef8,
    plateauTop: 0xdde6f5,
    plateauSide: 0x9eb1d0,
    kcnPadBase: 0xe2e8f0,
    kcnApron: 0xcbd5e1,
    plotPad: 0xc4d0df,
    primary: 0x0738cd,
    primaryDark: 0x042280,
    accent: 0xff0065,
    emeraldHighlight: 0x10b981,
    kcnActiveBorder: 0x0738cd,
    hoverAccent: 0xff0065,
    waterColor: 0x38bdf8,
    waterEmissive: 0x0369a1,
  },
  'ocean-trust': {
    id: 'ocean-trust',
    name: 'Ocean Trust',
    skyBg: 0xe7f4fb,
    fogColor: 0xe0f0f9,
    hemiSky: 0xf5fbff,
    hemiGround: 0x95b4c7,
    tableBase: 0xbad7e6,
    tableTop: 0xe4f2f9,
    plateauTop: 0xd6ebf6,
    plateauSide: 0x90bad1,
    kcnPadBase: 0xe0eef5,
    kcnApron: 0xc8dde8,
    plotPad: 0xc2d7e3,
    primary: 0x075985,
    primaryDark: 0x0e7490,
    accent: 0x0f766e,
    emeraldHighlight: 0x10b981,
    kcnActiveBorder: 0x0e7490,
    hoverAccent: 0x0284c7,
    waterColor: 0x0ea5e9,
    waterEmissive: 0x0369a1,
  },
  'emerald-growth': {
    id: 'emerald-growth',
    name: 'Emerald Growth',
    skyBg: 0xe8f6f0,
    fogColor: 0xe1f2eb,
    hemiSky: 0xf6fef9,
    hemiGround: 0x96b8ab,
    tableBase: 0xbedad0,
    tableTop: 0xe6f4ee,
    plateauTop: 0xd8eee5,
    plateauSide: 0x94c0b1,
    kcnPadBase: 0xe2f0ea,
    kcnApron: 0xcadfd7,
    plotPad: 0xc3d9d0,
    primary: 0x047857,
    primaryDark: 0x0f766e,
    accent: 0x1d4ed8,
    emeraldHighlight: 0x10b981,
    kcnActiveBorder: 0x059669,
    hoverAccent: 0x1d4ed8,
    waterColor: 0x38bdf8,
    waterEmissive: 0x0284c7,
  },
  'violet-future': {
    id: 'violet-future',
    name: 'Violet Future',
    skyBg: 0xf0ecf9,
    fogColor: 0xeae4f7,
    hemiSky: 0xfbf9ff,
    hemiGround: 0xa89fc2,
    tableBase: 0xcbc2e3,
    tableTop: 0xeee9f8,
    plateauTop: 0xe3dcf4,
    plateauSide: 0xa99cc9,
    kcnPadBase: 0xe8e4f2,
    kcnApron: 0xd5cfe6,
    plotPad: 0xcfc8e0,
    primary: 0x6d28d9,
    primaryDark: 0x4f46e5,
    accent: 0xbe185d,
    emeraldHighlight: 0x10b981,
    kcnActiveBorder: 0x6d28d9,
    hoverAccent: 0xbe185d,
    waterColor: 0x38bdf8,
    waterEmissive: 0x0369a1,
  },
  'executive-gold': {
    id: 'executive-gold',
    name: 'Executive Gold',
    skyBg: 0xeff2f6,
    fogColor: 0xe8edf3,
    hemiSky: 0xfafcff,
    hemiGround: 0xa0aab8,
    tableBase: 0xc6cfd9,
    tableTop: 0xe9eef3,
    plateauTop: 0xdde4ed,
    plateauSide: 0x9ba7b8,
    kcnPadBase: 0xe4e9ef,
    kcnApron: 0xcfd7e0,
    plotPad: 0xc8d0da,
    primary: 0x0f172a,
    primaryDark: 0x334155,
    accent: 0xb45309,
    emeraldHighlight: 0x10b981,
    kcnActiveBorder: 0xb45309,
    hoverAccent: 0xd97706,
    waterColor: 0x38bdf8,
    waterEmissive: 0x0369a1,
  },
});

const PALETTE = {
  emeraldHighlight: 0x16a34a,
  emeraldActive: 0x10b981,
  cyanHover: 0xea580c,
  slateInactive: 0x64748b,
  amberGlow: 0xf59e0b,
  warmWindow: 0xfbbf24,
  cleanroomCyan: 0x0ea5e9,
  cobaltFacade: 0xc2410c,
  asphaltRoad: 0x1e293b,
  roadMarking: 0xf8fafc,
  day: {
    skyBg: new THREE.Color(0xf7efe8),
    fogColor: new THREE.Color(0xf2e8df),
    hemiSky: new THREE.Color(0xfffaf5),
    hemiGround: new THREE.Color(0xb8a99a),
    hemiIntensity: 1.32,
    sunColor: new THREE.Color(0xfff9f0),
    sunIntensity: 2.05,
    rimColor: new THREE.Color(0xbae6fd),
    rimIntensity: 0.62,
    tableBase: new THREE.Color(0xdccbb8),
    tableTop: new THREE.Color(0xf4ece4),
    plateauTop: new THREE.Color(0xede2d7),
    plateauSide: new THREE.Color(0xc4ae98),
    waterColor: new THREE.Color(0x38bdf8),
    waterEmissive: new THREE.Color(0x0284c7),
    kcnPadBase: new THREE.Color(0xebe5df),
    kcnApron: new THREE.Color(0xdcd3ca),
    plotPad: new THREE.Color(0xd6cdc4),
  },
  night: {
    skyBg: new THREE.Color(0x060b16),
    fogColor: new THREE.Color(0x070d1b),
    hemiSky: new THREE.Color(0x1e3a5f),
    hemiGround: new THREE.Color(0x050811),
    hemiIntensity: 0.58,
    sunColor: new THREE.Color(0x60a5fa),
    sunIntensity: 0.78,
    rimColor: new THREE.Color(0x2dd4bf),
    rimIntensity: 0.48,
    tableBase: new THREE.Color(0x09101f),
    tableTop: new THREE.Color(0x0f172a),
    plateauTop: new THREE.Color(0x152238),
    plateauSide: new THREE.Color(0x0c1526),
    waterColor: new THREE.Color(0x0284c7),
    waterEmissive: new THREE.Color(0x0c4a6e),
    kcnPadBase: new THREE.Color(0x0b1324),
    kcnApron: new THREE.Color(0x162136),
    plotPad: new THREE.Color(0x1e293b),
  },
};

/**
 * Fallback real GPS metadata for all 13 BI Industrial Parks in case adapter data is still loading
 */
const FALLBACK_KCN_GPS = Object.freeze({
  VP_BA_THIEN_1: { lat: 21.3365, lng: 105.676 },
  VP_BA_THIEN_2: { lat: 21.3188, lng: 105.6865 },
  VP_BINH_XUYEN_1: { lat: 21.258, lng: 105.682 },
  VP_BINH_XUYEN_2: { lat: 21.2695, lng: 105.7025 },
  VP_KHAI_QUANG: { lat: 21.2985, lng: 105.619 },
  VP_THANG_LONG_3: { lat: 21.291, lng: 105.672 },
  PT_PHU_HA: { lat: 21.4285, lng: 105.2358 },
  PT_CAM_KHE: { lat: 21.4347, lng: 105.0592 },
  PT_THUY_VAN: { lat: 21.3392, lng: 105.3564 },
  HB_LUONG_SON: { lat: 20.892, lng: 105.524 },
  BG_QUANG_CHAU: { lat: 21.2225, lng: 106.121 },
  BG_VAN_TRUNG: { lat: 21.249, lng: 106.143 },
  BG_DINH_TRAM: { lat: 21.265, lng: 106.156 },
});

/**
 * Web Mercator Slippy Tile Math Helpers
 */
function latLngToTileFloat(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, Number(lat) || 21.3));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = ((Number(lng) + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function tileXYToLatLngCorner(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

function toVec3(input, fallback = [0, 0, 0]) {
  if (input instanceof THREE.Vector3) {
    return input.clone();
  }
  if (Array.isArray(input)) {
    if (input.length === 2) {
      return new THREE.Vector3(
        Number(input[0]) || 0,
        0,
        Number(input[1]) || 0
      );
    }
    return new THREE.Vector3(
      Number(input[0]) ?? fallback[0],
      Number(input[1]) ?? fallback[1],
      Number(input[2]) ?? fallback[2]
    );
  }
  if (input && typeof input === 'object') {
    return new THREE.Vector3(
      Number(input.x) ?? fallback[0],
      Number(input.y) ?? fallback[1],
      Number(input.z) ?? fallback[2]
    );
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function normalizeSide(side = 'south') {
  if (typeof side === 'number') {
    return SIDE_ORDER[(Math.max(1, Math.min(4, side)) - 1) % 4];
  }
  const s = String(side || 'south').toLowerCase().trim();
  if (s === '1' || s === 'view1' || s.includes('south') || s.includes('nam')) return 'south';
  if (s === '2' || s === 'view2' || s.includes('east') || s.includes('dong') || s.includes('đông')) return 'east';
  if (s === '3' || s === 'view3' || s.includes('north') || s.includes('bac') || s.includes('bắc')) return 'north';
  if (s === '4' || s === 'view4' || s.includes('west') || s.includes('tay') || s.includes('tây')) return 'west';
  return SIDE_VECTORS[s] ? s : 'south';
}

function parseHexColor(val, fallbackHex) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    try {
      return new THREE.Color(val.trim()).getHex();
    } catch {
      return fallbackHex;
    }
  }
  return fallbackHex;
}

export class BiSpatial3DEngine {
  constructor({
    canvas,
    skinId = 'hr-partner',
    mapStyle = 'street',
    tileOrigin = null,
    onHoverNode = null,
    onSelectKcn = null,
    onSelectCompany = null,
    onScreenAnchorsUpdate = null,
    onCompassUpdate = null,
    onTransitionStateChange = null,
  } = {}) {
    if (!canvas) {
      throw new Error('BiSpatial3DEngine requires a valid HTMLCanvasElement (`canvas`).');
    }

    this.canvas = canvas;
    this.tileOrigin = tileOrigin;
    this.renderPaused = false;
    this.onHoverNode = onHoverNode;
    this.onSelectKcn = onSelectKcn;
    this.onSelectCompany = onSelectCompany;
    this.onScreenAnchorsUpdate = onScreenAnchorsUpdate;
    this.onCompassUpdate = onCompassUpdate;
    this.onTransitionStateChange = onTransitionStateChange;

    // Hierarchy Data State
    this.hierarchyData = { provinces: [], industrial_parks: [], companies: [], jobs: [] };
    this.provincesByCode = new Map();
    this.kcnsByCode = new Map();
    this.companiesByKey = new Map();

    // Scene Navigation & Selection State
    this.currentLevel = 1; // 1 = Macro Map, 2 = KCN Zone Masterplan, 3 = Company Compound
    this.activeProvinceCode = null;
    this.activeKcnCode = null;
    this.activeCompanyKey = null;
    this.activeSide = 'south';
    this.is2DMode = false;

    // BI Skin & Map Basemap Style State
    this.activeSkinId = skinId || 'hr-partner';
    this.activeSkinTokens = SKIN_3D_THEMES[this.activeSkinId] || SKIN_3D_THEMES['hr-partner'];
    this.mapStyle = String(mapStyle || 'street').toLowerCase().includes('sat')
      ? 'satellite'
      : 'street';

    // Hover State (3D raycast or 2D drawer highlightNode)
    this.pointerHoveredNode = null; // { type: 'kcn' | 'company', key }
    this.externalHoveredNode = null; // { type: 'kcn' | 'company', key }
    this.effectiveHoveredKey = null;
    this.effectiveHoveredType = null;

    // Day / Night Atmospheric State (Default: Bright Daytime `isNight = false`)
    this.isNight = false;
    this.dayNightMix = 0; // 0 = Day, 1 = Night (smoothly interpolated)
    this.targetDayNightMix = 0;

    // Scene Graph Collections for Fast Updates
    this.kcnRecords = new Map(); // kcnCode -> KCN 3D Record
    this.companyRecords = new Map(); // companyKey -> Company 3D Record
    this.pickableMeshes = []; // Meshes with userData.pickNode = { type, key, kcnCode, companyKey }
    this.dynamicEmissiveMaterials = []; // { material, dayIntensity, nightIntensity, baseColor }
    this.streetLampMaterials = [];
    this.trafficVehicles = []; // 3D miniature cars, shuttle buses & motorbikes
    this.terrainMaterials = {};
    this.skinAccentMaterials = []; // Materials that update dynamically on setSkinTheme
    this.macroTileMeshes = []; // Level 1 macro map tile planes
    this.textureCache = new Map(); // url -> THREE.Texture

    // Geographic Projection Calibration State
    this.geoAffine = {
      originLat: 21.3,
      originLng: 105.68,
      scaleX: 430,
      scaleZ: 430,
      offsetX: 0,
      offsetZ: 0,
    };

    // World Metrics (auto-calibrated on setHierarchyData)
    this.worldBounds = {
      center: new THREE.Vector3(0, 0, 0),
      span: 260,
      spanX: 260,
      spanZ: 220,
      minX: -130,
      maxX: 130,
      minZ: -110,
      maxZ: 110,
      scale: 1,
    };

    // Camera Flight & Orbit Controller (`CurveController` cubic-Bezier spline)
    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.flightState = {
      active: false,
      startTime: 0,
      duration: 1000,
      posCurve: null,
      targetCurve: null,
      onComplete: null,
    };

    // Interactive Pointer / Touch Orbit & Zoom State
    this.spherical = new THREE.Spherical(190, Math.PI * 0.31, 0.12);
    this.targetSpherical = new THREE.Spherical(190, Math.PI * 0.31, 0.12);
    this.panOffset = new THREE.Vector3();
    this.targetPanOffset = new THREE.Vector3();
    this.pointerState = {
      isDown: false,
      button: 0,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      movedDistance: 0,
      activePointers: new Map(),
      lastPinchDist: 0,
    };

    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2(-99, -99);
    this.pointerClient = { x: -1, y: -1 };
    this.needsRaycast = false;
    this.clock = new THREE.Clock();
    this.elapsedTime = 0;
    this.isDisposed = false;
    this._projVec = new THREE.Vector3();
    this._camDirVec = new THREE.Vector3();
    this.textureLoader = new THREE.TextureLoader();
    this.textureLoader.setCrossOrigin('anonymous');

    this._applySkinPaletteToDayTokens(this.activeSkinId, {});
    this._initThree();
    this._initLighting();
    this._initGroups();
    this._initSharedVehicleAssets();
    this._bindEvents();
    this._startLoop();
  }

  /* ==========================================================================
   * 1. INITIALIZATION, SKIN THEME ENGINE & MAP STYLE SWITCHER
   * ========================================================================== */

  _initThree() {
    const width = this.canvas.clientWidth || window.innerWidth || 1280;
    const height = this.canvas.clientHeight || window.innerHeight || 720;

    this.scene = new THREE.Scene();
    this.scene.background = PALETTE.day.skyBg.clone();
    this.scene.fog = new THREE.FogExp2(PALETTE.day.fogColor.getHex(), 0.0012);

    this.camera = new THREE.PerspectiveCamera(42, width / Math.max(height, 1), 0.8, 4000);
    this.camera.position.set(16, 155, 195);
    this.camera.lookAt(this.cameraTarget);
    this.currentViewOffsetX = undefined;
    this._syncCameraViewOffset(width, height, true);
    this._syncSphericalFromCamera();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
  }

  _initLighting() {
    this.hemiLight = new THREE.HemisphereLight(
      PALETTE.day.hemiSky.getHex(),
      PALETTE.day.hemiGround.getHex(),
      PALETTE.day.hemiIntensity
    );
    this.hemiLight.position.set(0, 320, 0);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(
      PALETTE.day.sunColor.getHex(),
      PALETTE.day.sunIntensity
    );
    this.sunLight.position.set(140, 250, 135);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 1100;
    const d = 260;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.scene.add(this.sunLight);

    this.rimLight = new THREE.DirectionalLight(
      PALETTE.day.rimColor.getHex(),
      PALETTE.day.rimIntensity
    );
    this.rimLight.position.set(-160, 130, -140);
    this.scene.add(this.rimLight);
  }

  _initGroups() {
    this.rootGroup = new THREE.Group();
    this.terrainGroup = new THREE.Group();
    this.macroMapTileGroup = new THREE.Group();
    this.highwayGroup = new THREE.Group();
    this.kcnRootGroup = new THREE.Group();

    this.rootGroup.add(this.terrainGroup);
    this.rootGroup.add(this.macroMapTileGroup);
    this.rootGroup.add(this.highwayGroup);
    this.rootGroup.add(this.kcnRootGroup);
    this.scene.add(this.rootGroup);
  }

  _applySkinPaletteToDayTokens(skinId = 'hr-partner', customTokens = {}) {
    const normalizedId = String(skinId || 'hr-partner').toLowerCase().trim();
    const preset = SKIN_3D_THEMES[normalizedId] || SKIN_3D_THEMES['hr-partner'];
    this.activeSkinId = preset.id;

    const primaryHex = parseHexColor(customTokens?.primary, preset.primary);
    const primaryDarkHex = parseHexColor(customTokens?.primaryDark, preset.primaryDark);
    const accentHex = parseHexColor(customTokens?.accent, preset.accent);

    this.activeSkinTokens = {
      ...preset,
      primary: primaryHex,
      primaryDark: primaryDarkHex,
      accent: accentHex,
    };

    PALETTE.emeraldHighlight = preset.emeraldHighlight;
    PALETTE.emeraldActive = preset.kcnActiveBorder;
    PALETTE.cyanHover = accentHex;
    PALETTE.cobaltFacade = primaryHex;

    PALETTE.day.skyBg.setHex(parseHexColor(customTokens?.skyBg, preset.skyBg));
    PALETTE.day.fogColor.setHex(parseHexColor(customTokens?.fogColor, preset.fogColor));
    PALETTE.day.hemiSky.setHex(preset.hemiSky);
    PALETTE.day.hemiGround.setHex(preset.hemiGround);
    PALETTE.day.tableBase.setHex(preset.tableBase);
    PALETTE.day.tableTop.setHex(preset.tableTop);
    PALETTE.day.plateauTop.setHex(preset.plateauTop);
    PALETTE.day.plateauSide.setHex(preset.plateauSide);
    PALETTE.day.kcnPadBase.setHex(preset.kcnPadBase);
    PALETTE.day.kcnApron.setHex(preset.kcnApron);
    PALETTE.day.plotPad.setHex(preset.plotPad);
    PALETTE.day.waterColor.setHex(preset.waterColor);
    PALETTE.day.waterEmissive.setHex(preset.waterEmissive);
  }

  /**
   * Public API: Switch BI Skin Theme (`hr-partner`, `royal-navy`, `ocean-trust`,
   * `emerald-growth`, `violet-future`, `executive-gold`) in real time
   */
  setSkinTheme(skinId = 'hr-partner', skinTokens = {}) {
    this._applySkinPaletteToDayTokens(skinId, skinTokens || {});

    // Update registered skin-reactive materials (factory facades, KCN beacons, grid rings)
    for (const item of this.skinAccentMaterials) {
      if (!item?.material) continue;
      const targetHex =
        item.role === 'accent'
          ? this.activeSkinTokens.accent
          : item.role === 'primaryDark'
            ? this.activeSkinTokens.primaryDark
            : item.role === 'kcnActiveBorder'
              ? this.activeSkinTokens.kcnActiveBorder
              : this.activeSkinTokens.primary;
      if (item.material.color) item.material.color.setHex(targetHex);
      if (item.updateEmissive && item.material.emissive) {
        item.material.emissive.setHex(targetHex);
      }
    }

    // Update KCN active borders
    for (const [, rec] of this.kcnRecords) {
      if (rec.isActive) {
        rec.baseBorderColor = this.activeSkinTokens.kcnActiveBorder;
        rec.borderMat.color.setHex(rec.baseBorderColor);
        rec.borderMat.emissive.setHex(rec.baseBorderColor);
      }
    }

    this._applyAtmosphereUniforms(this.dayNightMix);
    return this.activeSkinId;
  }

  getSkinTheme() {
    return this.activeSkinId;
  }

  /**
   * Public API: Switch 3D ground basemap style between `'street'` (Carto Voyager / OSM Street Map)
   * and `'satellite'` (Esri World Imagery Satellite)
   */
  setMapStyle(style = 'street') {
    const s = String(style || 'street').toLowerCase().trim();
    const nextStyle =
      s.includes('sat') || s.includes('hybrid') || s.includes('ve-tinh') || s.includes('vệ tinh')
        ? 'satellite'
        : 'street';

    const changed = this.mapStyle !== nextStyle;
    this.mapStyle = nextStyle;

    // Refresh Level 1 macro map tiles
    this._refreshMacroMapTileTextures();

    // Refresh Level 2/3 KCN high-zoom map canvases
    for (const [, kcnRec] of this.kcnRecords) {
      if (kcnRec.mapPadState) {
        kcnRec.mapPadState.loadedStyle = null;
        if (
          changed ||
          kcnRec.kcnCode === this.activeKcnCode ||
          kcnRec.mapPadState.isLoaded
        ) {
          this._loadKcnHighZoomMapCanvas(kcnRec, this.mapStyle);
        }
      }
    }

    this._applyAtmosphereUniforms(this.dayNightMix);
    return this.mapStyle;
  }

  toggleMapStyle() {
    return this.setMapStyle(this.mapStyle === 'satellite' ? 'street' : 'satellite');
  }

  getMapStyle() {
    return this.mapStyle;
  }

  /* ==========================================================================
   * 2. DATA INGESTION & GEOGRAPHIC PROJECTION CALIBRATION
   * ========================================================================== */

  setHierarchyData(hierarchyData, { preserveView = true } = {}) {
    if (!hierarchyData || typeof hierarchyData !== 'object') return;

    this.hierarchyData = hierarchyData;
    const provinces = Array.isArray(hierarchyData.provinces) ? hierarchyData.provinces : [];
    const industrialParks = Array.isArray(hierarchyData.industrial_parks)
      ? hierarchyData.industrial_parks
      : [];
    const companies = Array.isArray(hierarchyData.companies) ? hierarchyData.companies : [];

    this.provincesByCode.clear();
    this.kcnsByCode.clear();
    this.companiesByKey.clear();

    for (const prov of provinces) {
      if (prov?.province_code) {
        this.provincesByCode.set(prov.province_code, prov);
      }
    }

    for (const comp of companies) {
      if (comp?.company_key) {
        this.companiesByKey.set(comp.company_key, comp);
      }
    }

    for (const kcn of industrialParks) {
      if (!kcn?.industrial_park_code) continue;
      const fallbackGps = FALLBACK_KCN_GPS[kcn.industrial_park_code] || {
        lat: 21.3,
        lng: 105.68,
      };
      const lat = Number(kcn.lat) || fallbackGps.lat;
      const lng = Number(kcn.lng) || fallbackGps.lng;

      const kcnCompanies =
        Array.isArray(kcn.companies) && kcn.companies.length > 0
          ? kcn.companies
          : companies.filter((c) => c.industrial_park_code === kcn.industrial_park_code);
      const enrichedKcn = {
        ...kcn,
        lat,
        lng,
        googleMapsUrl:
          kcn.googleMapsUrl || `https://www.google.com/maps?q=${lat.toFixed(5)},${lng.toFixed(5)}`,
        companies: kcnCompanies,
      };
      this.kcnsByCode.set(kcn.industrial_park_code, enrichedKcn);
      for (const comp of kcnCompanies) {
        if (comp?.company_key && !this.companiesByKey.has(comp.company_key)) {
          this.companiesByKey.set(comp.company_key, comp);
        }
      }
    }

    const kcnList = Array.from(this.kcnsByCode.values());
    this._calibrateWorldMetrics(provinces, kcnList);
    this._calibrateGeoProjection(kcnList);
    this._clearSceneObjects();

    this._buildMacroTerrainAndRivers(provinces, kcnList);
    this._buildMacroMapTileLayer(kcnList);
    this._buildHighwayNetwork(provinces, kcnList);
    this._buildAllKcnCompounds(kcnList);

    // Apply current skin + day/night lighting state immediately
    this._applyAtmosphereUniforms(this.dayNightMix);

    // Preload high-zoom KCN map tiles for active or featured KCNs
    const preloadCodes = new Set(
      [
        this.activeKcnCode,
        'VP_BA_THIEN_2',
        'VP_BA_THIEN_1',
        'BG_QUANG_CHAU',
        'PT_PHU_HA',
      ].filter(Boolean)
    );
    for (const code of preloadCodes) {
      const rec = this.kcnRecords.get(code);
      if (rec) this._loadKcnHighZoomMapCanvas(rec, this.mapStyle);
    }

    // Restore or initialize camera view
    if (preserveView && this.currentLevel === 3 && this.companiesByKey.has(this.activeCompanyKey)) {
      this._updateDimmingState();
    } else if (preserveView && this.currentLevel === 2 && this.kcnsByCode.has(this.activeKcnCode)) {
      this.activeCompanyKey = null;
      this._updateDimmingState();
    } else {
      this.currentLevel = 1;
      this.activeKcnCode = null;
      this.activeCompanyKey = null;
      this.flyToLevel1({ provinceCode: this.activeProvinceCode, immediate: true });
    }
  }

  _calibrateWorldMetrics(provinces, kcns) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const kcn of kcns) {
      const p = toVec3(kcn.worldPosition, [0, 0, 0]);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    for (const prov of provinces) {
      if (prov.mapPosition) {
        const p = toVec3(prov.mapPosition, [0, 0, 0]);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }

    if (!Number.isFinite(minX)) {
      minX = -150;
      maxX = 150;
      minZ = -120;
      maxZ = 120;
    }

    const spanX = Math.max(maxX - minX, 120);
    const spanZ = Math.max(maxZ - minZ, 100);
    const span = Math.max(spanX, spanZ, 140);
    const center = new THREE.Vector3((minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5);
    const scale = span / 220;

    this.worldBounds = {
      center,
      span,
      spanX,
      spanZ,
      minX,
      maxX,
      minZ,
      maxZ,
      scale,
    };

    const shadowHalf = Math.max(span * 0.98, 220);
    this.sunLight.position.set(
      center.x + span * 0.52,
      Math.max(span * 0.96, 200),
      center.z + span * 0.46
    );
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
    this.sunLight.shadow.camera.far = Math.max(span * 3.8, 1100);
    this.sunLight.shadow.camera.updateProjectionMatrix();

    this.scene.fog.density = 0.00095 / Math.max(scale, 0.55);
  }

  /**
   * Calibrates `(lat, lng) <-> (worldX, worldZ)` using `GeoAdapter.GEO_PROJECTION` when exported,
   * or a least-squares affine fit against the 13 KCN world positions & GPS coordinates.
   */
  _calibrateGeoProjection(kcns) {
    const adapterGeo =
      this.hierarchyData?.geoProjection ||
      this.hierarchyData?.meta?.geoProjection ||
      GeoAdapter?.GEO_PROJECTION ||
      null;

    this.externalGeoProjection = adapterGeo;

    const originLat = Number(adapterGeo?.ORIGIN_LAT) || 21.3;
    const originLng = Number(adapterGeo?.ORIGIN_LNG) || 105.68;
    const cosLat = Math.cos((originLat * Math.PI) / 180);

    // Least-squares fit of worldX vs (lng - originLng)*cosLat and worldZ vs -(lat - originLat)
    let sumDLng2 = 0;
    let sumDLngX = 0;
    let sumDLat2 = 0;
    let sumDLatZ = 0;

    for (const kcn of kcns) {
      if (!Number.isFinite(kcn.lat) || !Number.isFinite(kcn.lng)) continue;
      const wp = toVec3(kcn.worldPosition);
      const dLng = (kcn.lng - originLng) * cosLat;
      const dLat = -(kcn.lat - originLat);
      sumDLng2 += dLng * dLng;
      sumDLngX += dLng * wp.x;
      sumDLat2 += dLat * dLat;
      sumDLatZ += dLat * wp.z;
    }

    const fittedScaleX = sumDLng2 > 1e-5 ? Math.max(220, Math.abs(sumDLngX / sumDLng2)) : 430;
    const fittedScaleZ = sumDLat2 > 1e-5 ? Math.max(220, Math.abs(sumDLatZ / sumDLat2)) : 430;

    this.geoAffine = {
      originLat,
      originLng,
      cosLat,
      scaleX: fittedScaleX,
      scaleZ: fittedScaleZ,
    };
  }

  _latLngToWorld(lat, lng) {
    const ext = this.externalGeoProjection;
    if (ext && typeof ext.latLngToWorld === 'function') {
      const res = ext.latLngToWorld(lat, lng);
      if (Array.isArray(res)) {
        return { x: Number(res[0]) || 0, z: Number(res[res.length === 3 ? 2 : 1]) || 0 };
      }
      if (res && typeof res === 'object') {
        return { x: Number(res.x) || 0, z: Number(res.z) || 0 };
      }
    }
    const { originLat, originLng, cosLat, scaleX, scaleZ } = this.geoAffine;
    return {
      x: (Number(lng) - originLng) * cosLat * scaleX,
      z: -(Number(lat) - originLat) * scaleZ,
    };
  }

  _worldToLatLng(x, z) {
    const ext = this.externalGeoProjection;
    if (ext && typeof ext.worldToLatLng === 'function') {
      const res = ext.worldToLatLng(x, z);
      if (res && typeof res === 'object') {
        return { lat: Number(res.lat) || 21.3, lng: Number(res.lng) || 105.68 };
      }
    }
    const { originLat, originLng, cosLat, scaleX, scaleZ } = this.geoAffine;
    return {
      lng: originLng + Number(x) / Math.max(cosLat * scaleX, 1),
      lat: originLat - Number(z) / Math.max(scaleZ, 1),
    };
  }

  _clearSceneObjects() {
    const disposeGroup = (group) => {
      group.traverse((child) => {
        if (child.geometry && !child.geometry.userData?.shared) {
          child.geometry.dispose();
        }
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (!m.userData?.shared) {
              m.dispose();
            }
          }
        }
      });
      group.clear();
    };

    disposeGroup(this.terrainGroup);
    disposeGroup(this.macroMapTileGroup);
    disposeGroup(this.highwayGroup);
    disposeGroup(this.kcnRootGroup);

    this.kcnRecords.clear();
    this.companyRecords.clear();
    this.pickableMeshes = [];
    this.dynamicEmissiveMaterials = [];
    this.streetLampMaterials = [];
    this.trafficVehicles = [];
    this.terrainMaterials = {};
    this.skinAccentMaterials = [];
    this.macroTileMeshes = [];
  }

  /* ==========================================================================
   * 3. LEVEL 1: MACRO TERRAIN TABLE, DRAPED REAL GEOGRAPHIC MAP TILES & RIVERS
   * ========================================================================== */

  _buildMacroTerrainAndRivers(provinces, kcns) {
    const { center, span, spanX, spanZ, scale } = this.worldBounds;
    const s = Math.max(scale, 0.5);

    const tableW = spanX + 210 * s;
    const tableD = spanZ + 190 * s;

    const baseMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.tableBase.clone(),
      roughness: 0.86,
      metalness: 0.06,
    });
    const topMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.tableTop.clone(),
      roughness: 0.82,
      metalness: 0.05,
    });
    const plateauTopMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.plateauTop.clone(),
      roughness: 0.72,
      metalness: 0.06,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });
    const plateauSideMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.plateauSide.clone(),
      roughness: 0.65,
      metalness: 0.12,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const waterMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.waterColor.clone(),
      emissive: PALETTE.day.waterEmissive.clone(),
      emissiveIntensity: 0.18,
      roughness: 0.22,
      metalness: 0.45,
      transparent: true,
      opacity: 0.68,
    });

    this.terrainMaterials = {
      baseMat,
      topMat,
      plateauTopMat,
      plateauSideMat,
      waterMat,
      tableW,
      tableD,
    };

    // Deep Architectural Maquette Base Table
    const subBaseGeo = new THREE.BoxGeometry(tableW * 1.03, 5.5 * s, tableD * 1.03);
    const subBaseMesh = new THREE.Mesh(subBaseGeo, baseMat);
    subBaseMesh.position.set(center.x, -4.4 * s, center.z);
    subBaseMesh.receiveShadow = true;
    this.terrainGroup.add(subBaseMesh);

    const mainTableGeo = new THREE.BoxGeometry(tableW, 2.8 * s, tableD);
    const mainTableMesh = new THREE.Mesh(mainTableGeo, topMat);
    mainTableMesh.position.set(center.x, -1.45 * s, center.z);
    mainTableMesh.receiveShadow = true;
    this.terrainGroup.add(mainTableMesh);

    // Subtle Architectural Coordinate Grid above the map plane
    const gridSize = Math.max(tableW, tableD) * 1.02;
    const gridHelper = new THREE.GridHelper(
      gridSize,
      36,
      this.activeSkinTokens.primary,
      0x94a3b8
    );
    gridHelper.position.set(center.x, 0.09 * s, center.z);
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.11;
    gridHelper.material.depthWrite = false;
    this.terrainGroup.add(gridHelper);

    // Compass Range Rings on the Maquette Table
    for (let i = 1; i <= 3; i++) {
      const ringRadius = span * 0.24 * i;
      const ringGeo = new THREE.RingGeometry(ringRadius - 0.32 * s, ringRadius, 96);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: i === 2 ? this.activeSkinTokens.primary : 0x64748b,
        transparent: true,
        opacity: i === 2 ? 0.18 : 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      if (i === 2) {
        this.skinAccentMaterials.push({ material: ringMat, role: 'primary' });
      }
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.set(center.x, 0.1 * s, center.z);
      this.terrainGroup.add(ringMesh);
    }

    // Translucent 3D Province Contour Frames (`Vĩnh Phúc`, `Bắc Giang`, `Phú Thọ`, `Hòa Bình`)
    // Translucent so the real geographic map tiles draped on the ground remain 100% readable!
    const provinceClusters = new Map();
    for (const prov of provinces) {
      provinceClusters.set(prov.province_code, {
        prov,
        points: [],
      });
    }
    for (const kcn of kcns) {
      if (!provinceClusters.has(kcn.province_code)) {
        provinceClusters.set(kcn.province_code, {
          prov: { province_code: kcn.province_code, province_name: kcn.province_name },
          points: [],
        });
      }
      provinceClusters.get(kcn.province_code).points.push(toVec3(kcn.worldPosition));
    }

    for (const [, cluster] of provinceClusters) {
      const prov = cluster.prov || {};
      if (cluster.points.length === 0 && prov.mapPosition) {
        cluster.points.push(toVec3(prov.mapPosition));
      }
      if (cluster.points.length === 0) continue;

      let pMinX = Infinity;
      let pMaxX = -Infinity;
      let pMinZ = Infinity;
      let pMaxZ = -Infinity;
      for (const pt of cluster.points) {
        if (pt.x < pMinX) pMinX = pt.x;
        if (pt.x > pMaxX) pMaxX = pt.x;
        if (pt.z < pMinZ) pMinZ = pt.z;
        if (pt.z > pMaxZ) pMaxZ = pt.z;
      }

      const cx = (pMinX + pMaxX) * 0.5;
      const cz = (pMinZ + pMaxZ) * 0.5;
      const pw = Math.max(pMaxX - pMinX + 68 * s, 96 * s);
      const pd = Math.max(pMaxZ - pMinZ + 58 * s, 82 * s);

      // Rounded / chamfered province contour polygon border at y = 0.16 * s
      const ch = Math.min(pw, pd) * 0.14;
      const hw = pw * 0.5;
      const hd = pd * 0.5;
      const contourPts = [
        new THREE.Vector3(cx - hw + ch, 0.18 * s, cz - hd),
        new THREE.Vector3(cx + hw - ch, 0.18 * s, cz - hd),
        new THREE.Vector3(cx + hw, 0.18 * s, cz - hd + ch),
        new THREE.Vector3(cx + hw, 0.18 * s, cz + hd - ch),
        new THREE.Vector3(cx + hw - ch, 0.18 * s, cz + hd),
        new THREE.Vector3(cx - hw + ch, 0.18 * s, cz + hd),
        new THREE.Vector3(cx - hw, 0.18 * s, cz + hd - ch),
        new THREE.Vector3(cx - hw, 0.18 * s, cz - hd + ch),
        new THREE.Vector3(cx - hw + ch, 0.18 * s, cz - hd),
      ];

      const accentHex = prov.color
        ? new THREE.Color(prov.color).getHex()
        : this.activeSkinTokens.primary;
      const borderGeo = new THREE.BufferGeometry().setFromPoints(contourPts);
      const borderMat = new THREE.LineBasicMaterial({
        color: accentHex,
        transparent: true,
        opacity: 0.62,
      });
      this.terrainGroup.add(new THREE.Line(borderGeo, borderMat));
    }

    // Stylized Rivers (Sông Hồng & Sông Cầu) gently blending over the macro map
    const riverDefinitions = [
      [
        new THREE.Vector3(center.x - span * 0.58, 0.08 * s, center.z - span * 0.28),
        new THREE.Vector3(center.x - span * 0.25, 0.08 * s, center.z + span * 0.08),
        new THREE.Vector3(center.x + span * 0.02, 0.08 * s, center.z + span * 0.25),
        new THREE.Vector3(center.x + span * 0.48, 0.08 * s, center.z + span * 0.42),
      ],
      [
        new THREE.Vector3(center.x + span * 0.05, 0.08 * s, center.z - span * 0.42),
        new THREE.Vector3(center.x + span * 0.24, 0.08 * s, center.z - span * 0.12),
        new THREE.Vector3(center.x + span * 0.46, 0.08 * s, center.z + span * 0.06),
        new THREE.Vector3(center.x + span * 0.62, 0.08 * s, center.z + span * 0.18),
      ],
    ];

    for (const pts of riverDefinitions) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(curve, 64, 1.8 * s, 8, false);
      tubeGeo.scale(1, 0.06, 1);
      const riverMesh = new THREE.Mesh(tubeGeo, waterMat);
      riverMesh.position.y = 0.05 * s;
      this.terrainGroup.add(riverMesh);
    }
  }

  /**
   * Stitches and drapes Real Geographic Map Tiles (`/api/map-tile?style=street|satellite&z=10&x=...&y=...`)
   * onto the Level 1 Macro Map 3D Ground Plane.
   */
  _buildMacroMapTileLayer() {
    if (!this.tileOrigin) return;
    const { center, spanX, spanZ, scale } = this.worldBounds;
    const s = Math.max(scale, 0.5);
    const groundY = 0.03 * s;

    let tiles = [];
    const ext = this.externalGeoProjection;

    if (ext && typeof ext.getMacroMapTileGrid === 'function') {
      try {
        const gridResult = ext.getMacroMapTileGrid({ style: this.mapStyle });
        if (Array.isArray(gridResult)) {
          tiles = gridResult;
        } else if (Array.isArray(gridResult?.tiles)) {
          tiles = gridResult.tiles;
        } else if (
          gridResult &&
          Number.isFinite(gridResult.zoom ?? gridResult.z) &&
          Number.isFinite(gridResult.minTileX) &&
          Number.isFinite(gridResult.maxTileX)
        ) {
          const z = gridResult.zoom ?? gridResult.z;
          for (let ty = gridResult.minTileY; ty <= gridResult.maxTileY; ty++) {
            for (let tx = gridResult.minTileX; tx <= gridResult.maxTileX; tx++) {
              tiles.push({ z, x: tx, y: ty });
            }
          }
        }
      } catch {
        tiles = [];
      }
    }

    // Fallback: compute zoom=10 slippy tile grid covering the macro world table bounds
    if (tiles.length === 0) {
      const zoom = 10;
      const padX = spanX * 0.58 + 55 * s;
      const padZ = spanZ * 0.58 + 50 * s;
      const nwLatLng = this._worldToLatLng(center.x - padX, center.z - padZ);
      const seLatLng = this._worldToLatLng(center.x + padX, center.z + padZ);

      const minLat = Math.max(20.65, Math.min(nwLatLng.lat, seLatLng.lat));
      const maxLat = Math.min(21.75, Math.max(nwLatLng.lat, seLatLng.lat));
      const minLng = Math.max(104.85, Math.min(nwLatLng.lng, seLatLng.lng));
      const maxLng = Math.min(106.45, Math.max(nwLatLng.lng, seLatLng.lng));

      const nwTile = latLngToTileFloat(maxLat, minLng, zoom);
      const seTile = latLngToTileFloat(minLat, maxLng, zoom);

      const minTX = Math.floor(Math.min(nwTile.x, seTile.x));
      const maxTX = Math.floor(Math.max(nwTile.x, seTile.x));
      const minTY = Math.floor(Math.min(nwTile.y, seTile.y));
      const maxTY = Math.floor(Math.max(nwTile.y, seTile.y));

      // Cap grid to max 7x5 = 35 tiles for fast loading
      const clampedMaxTX = Math.min(maxTX, minTX + 6);
      const clampedMaxTY = Math.min(maxTY, minTY + 4);

      for (let ty = minTY; ty <= clampedMaxTY; ty++) {
        for (let tx = minTX; tx <= clampedMaxTX; tx++) {
          tiles.push({ z: zoom, x: tx, y: ty });
        }
      }
    }

    this.macroTileMeshes = [];

    for (const tile of tiles) {
      const z = Number(tile.z ?? tile.zoom ?? 10);
      const tx = Number(tile.x ?? tile.tileX);
      const ty = Number(tile.y ?? tile.tileY);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;

      let minX;
      let maxX;
      let minZ;
      let maxZ;

      if (
        Number.isFinite(tile.minX) &&
        Number.isFinite(tile.maxX) &&
        Number.isFinite(tile.minZ) &&
        Number.isFinite(tile.maxZ)
      ) {
        minX = tile.minX;
        maxX = tile.maxX;
        minZ = tile.minZ;
        maxZ = tile.maxZ;
      } else if (tile.worldBounds && Number.isFinite(tile.worldBounds.minX)) {
        minX = tile.worldBounds.minX;
        maxX = tile.worldBounds.maxX;
        minZ = tile.worldBounds.minZ;
        maxZ = tile.worldBounds.maxZ;
      } else {
        const nw = tileXYToLatLngCorner(tx, ty, z);
        const se = tileXYToLatLngCorner(tx + 1, ty + 1, z);
        const nwWorld = this._latLngToWorld(nw.lat, nw.lng);
        const seWorld = this._latLngToWorld(se.lat, se.lng);
        minX = Math.min(nwWorld.x, seWorld.x);
        maxX = Math.max(nwWorld.x, seWorld.x);
        minZ = Math.min(nwWorld.z, seWorld.z);
        maxZ = Math.max(nwWorld.z, seWorld.z);
      }

      const tileW = Math.max(Math.abs(maxX - minX), 1);
      const tileD = Math.max(Math.abs(maxZ - minZ), 1);
      const cx = (minX + maxX) * 0.5;
      const cz = (minZ + maxZ) * 0.5;

      const planeGeo = new THREE.PlaneGeometry(tileW * 1.003, tileD * 1.003);
      planeGeo.rotateX(-Math.PI / 2);

      const tileMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0.04,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

      const tileMesh = new THREE.Mesh(planeGeo, tileMat);
      tileMesh.position.set(cx, groundY, cz);
      tileMesh.receiveShadow = true;
      this.macroMapTileGroup.add(tileMesh);

      const record = { mesh: tileMesh, material: tileMat, z, x: tx, y: ty };
      this.macroTileMeshes.push(record);
      this._assignTileTextureToMaterial(tileMat, this.mapStyle, z, tx, ty);
    }
  }

  _buildTileUrl(style, z, x, y) {
    const cleanStyle = style === 'satellite' ? 'satellite' : 'street';
    return `${this.tileOrigin}/${cleanStyle}/${z}/${x}/${y}.png`;
  }

  _assignTileTextureToMaterial(material, style, z, x, y) {
    const url = this._buildTileUrl(style, z, x, y);
    if (this.textureCache.has(url)) {
      material.map = this.textureCache.get(url);
      material.needsUpdate = true;
      return;
    }

    this.textureLoader.load(
      url,
      (tex) => {
        if (this.isDisposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8);
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        this.textureCache.set(url, tex);
        if (this._buildTileUrl(this.mapStyle, z, x, y) === url) {
          material.map = tex;
          material.needsUpdate = true;
        }
      },
      undefined,
      () => {
        // Fallback if offline or tile proxy not ready yet
      }
    );
  }

  _refreshMacroMapTileTextures() {
    for (const rec of this.macroTileMeshes) {
      this._assignTileTextureToMaterial(rec.material, this.mapStyle, rec.z, rec.x, rec.y);
    }
  }

  /* ==========================================================================
   * 4. REALISTIC 3D MINIATURE VEHICLES: CARS, SHUTTLE BUSES & MOTORBIKES WITH RIDERS
   * ========================================================================== */

  _initSharedVehicleAssets() {
    const markShared = (obj) => {
      obj.userData = { ...(obj.userData || {}), shared: true };
      return obj;
    };

    this.vehicleShared = {
      tireMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0x111827,
          roughness: 0.85,
          metalness: 0.15,
        })
      ),
      rimMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          roughness: 0.3,
          metalness: 0.78,
        })
      ),
      darkGlassMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          roughness: 0.14,
          metalness: 0.85,
        })
      ),
      darkTrimMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0x1e293b,
          roughness: 0.7,
          metalness: 0.25,
        })
      ),
      headlightMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xfef08a,
          emissiveIntensity: 1.45,
          roughness: 0.15,
        })
      ),
      taillightMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xef4444,
          emissive: 0xef4444,
          emissiveIntensity: 1.35,
          roughness: 0.2,
        })
      ),
      amberVisorMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0xf59e0b,
          emissiveIntensity: 1.25,
          roughness: 0.2,
        })
      ),
      riderPantsMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0x1e293b,
          roughness: 0.8,
          metalness: 0.1,
        })
      ),
      skinMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xfed7aa,
          roughness: 0.65,
          metalness: 0.05,
        })
      ),
      safetyVestMat: markShared(
        new THREE.MeshStandardMaterial({
          color: 0xa3e635,
          emissive: 0x65a30d,
          emissiveIntensity: 0.45,
          roughness: 0.4,
        })
      ),
      bodyMaterials: new Map(),
    };
  }

  _getVehicleBodyMaterial(hexColor, roughness = 0.32, metalness = 0.42) {
    const key = `${hexColor}_${roughness}_${metalness}`;
    if (!this.vehicleShared.bodyMaterials.has(key)) {
      const mat = new THREE.MeshStandardMaterial({
        color: hexColor,
        roughness,
        metalness,
      });
      mat.userData = { shared: true };
      this.vehicleShared.bodyMaterials.set(key, mat);
    }
    return this.vehicleShared.bodyMaterials.get(key);
  }

  /**
   * 3D Automobile / Sedan & SUV (`_createCarMesh(color, variant)`)
   * Local +Z is FORWARD (front hood & headlights); Local -Z is REAR (trunk & brake lights).
   */
  _createCarMesh(color = 0x2563eb, variant = 'sedan') {
    const carGroup = new THREE.Group();
    const isSuv = variant === 'suv';
    const bodyMat = this._getVehicleBodyMaterial(color, 0.28, 0.48);
    const {
      tireMat,
      rimMat,
      darkGlassMat,
      darkTrimMat,
      headlightMat,
      taillightMat,
    } = this.vehicleShared;

    // 1. Lower Chassis Body + Front Hood + Rear Trunk
    const lowerBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.22, 1.42),
      bodyMat
    );
    lowerBody.position.set(0, 0.21, 0);
    lowerBody.castShadow = true;
    carGroup.add(lowerBody);

    // Front Hood Slope (+Z)
    const hoodMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.64, 0.16, 0.38),
      bodyMat
    );
    hoodMesh.position.set(0, 0.23, 0.52);
    hoodMesh.rotation.x = 0.12;
    carGroup.add(hoodMesh);

    // Front Grille & Rear Bumper
    const frontBumper = new THREE.Mesh(
      new THREE.BoxGeometry(0.66, 0.11, 0.08),
      darkTrimMat
    );
    frontBumper.position.set(0, 0.15, 0.71);
    const rearBumper = new THREE.Mesh(
      new THREE.BoxGeometry(0.66, 0.11, 0.08),
      darkTrimMat
    );
    rearBumper.position.set(0, 0.15, -0.71);
    carGroup.add(frontBumper, rearBumper);

    // 2. Upper Cabin Roof & Dark Tinted Windows (Windshield, Side & Rear Windows)
    const cabinLen = isSuv ? 0.88 : 0.72;
    const cabinZ = isSuv ? -0.1 : -0.04;
    const cabinH = isSuv ? 0.23 : 0.2;

    const glassBlock = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, cabinH * 0.86, cabinLen * 0.94),
      darkGlassMat
    );
    glassBlock.position.set(0, 0.39, cabinZ);
    carGroup.add(glassBlock);

    const roofTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 0.05, cabinLen * 0.82),
      bodyMat
    );
    roofTop.position.set(0, 0.39 + cabinH * 0.45, cabinZ);
    roofTop.castShadow = true;
    carGroup.add(roofTop);

    // Angled Front Windshield (+Z) & Rear Windshield (-Z)
    const frontWindshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 0.21, 0.04),
      darkGlassMat
    );
    frontWindshield.position.set(0, 0.38, cabinZ + cabinLen * 0.46);
    frontWindshield.rotation.x = -0.52;
    carGroup.add(frontWindshield);

    const rearWindshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.19, 0.04),
      darkGlassMat
    );
    rearWindshield.position.set(0, 0.38, cabinZ - cabinLen * 0.46);
    rearWindshield.rotation.x = isSuv ? 0.25 : 0.48;
    carGroup.add(rearWindshield);

    // Left & Right Side Mirrors
    const mirrorGeo = new THREE.BoxGeometry(0.08, 0.05, 0.06);
    const leftMirror = new THREE.Mesh(mirrorGeo, bodyMat);
    leftMirror.position.set(0.36, 0.33, 0.24);
    const rightMirror = new THREE.Mesh(mirrorGeo, bodyMat);
    rightMirror.position.set(-0.36, 0.33, 0.24);
    carGroup.add(leftMirror, rightMirror);

    // 3. 4 Cylindrical Black Rubber Wheels with Silver Alloy Hubcaps
    const tireGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.11, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.12, 10);
    rimGeo.rotateZ(Math.PI / 2);

    const wheelCoords = [
      [-0.33, 0.13, 0.44],
      [0.33, 0.13, 0.44],
      [-0.33, 0.13, -0.44],
      [0.33, 0.13, -0.44],
    ];
    for (const [wx, wy, wz] of wheelCoords) {
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.position.set(wx, wy, wz);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.set(wx, wy, wz);
      carGroup.add(tire, rim);
    }

    // 4. Glowing White Front Headlights (+Z) & Red Rear Brake Lights (-Z)
    const headGeo = new THREE.BoxGeometry(0.13, 0.065, 0.04);
    const leftHead = new THREE.Mesh(headGeo, headlightMat);
    leftHead.position.set(0.22, 0.22, 0.72);
    const rightHead = new THREE.Mesh(headGeo, headlightMat);
    rightHead.position.set(-0.22, 0.22, 0.72);

    const tailGeo = new THREE.BoxGeometry(0.15, 0.065, 0.04);
    const leftTail = new THREE.Mesh(tailGeo, taillightMat);
    leftTail.position.set(0.22, 0.23, -0.72);
    const rightTail = new THREE.Mesh(tailGeo, taillightMat);
    rightTail.position.set(-0.22, 0.23, -0.72);

    carGroup.add(leftHead, rightHead, leftTail, rightTail);
    return carGroup;
  }

  /**
   * 3D 45-Seat Worker Shuttle Bus (`Xe ca đưa đón công nhân`)
   * Long coach body, panoramic side windows, front LED destination visor, rooftop AC pod, 6 wheels.
   */
  _createShuttleBusMesh(bodyColor = 0xf8fafc, stripeColor = 0x0284c7) {
    const busGroup = new THREE.Group();
    const bodyMat = this._getVehicleBodyMaterial(bodyColor, 0.34, 0.32);
    const stripeMat = this._getVehicleBodyMaterial(stripeColor, 0.3, 0.4);
    const acPodMat = this._getVehicleBodyMaterial(0xe2e8f0, 0.5, 0.25);
    const {
      tireMat,
      rimMat,
      darkGlassMat,
      darkTrimMat,
      headlightMat,
      taillightMat,
      amberVisorMat,
    } = this.vehicleShared;

    // 1. Lower Coach Body & Livery Stripe
    const lowerCoach = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.44, 2.38),
      bodyMat
    );
    lowerCoach.position.set(0, 0.35, 0);
    lowerCoach.castShadow = true;
    busGroup.add(lowerCoach);

    const liveryStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.11, 2.34),
      stripeMat
    );
    liveryStripe.position.set(0, 0.36, 0);
    busGroup.add(liveryStripe);

    // 2. Upper Panoramic Dark Glass Passenger Deck + Roof Cap
    const panoramicDeck = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.33, 2.28),
      darkGlassMat
    );
    panoramicDeck.position.set(0, 0.72, 0);
    busGroup.add(panoramicDeck);

    // Corner body pillars & roof cap
    const roofCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.08, 2.36),
      bodyMat
    );
    roofCap.position.set(0, 0.91, 0);
    roofCap.castShadow = true;
    busGroup.add(roofCap);

    // Front & Rear structural pillar frames
    const frontCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.34, 0.08),
      bodyMat
    );
    frontCap.position.set(0, 0.72, 1.15);
    const rearCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.34, 0.1),
      bodyMat
    );
    rearCap.position.set(0, 0.72, -1.14);
    busGroup.add(frontCap, rearCap);

    // Large Front Windshield (+Z) & Illuminated LED Destination Board ("XE CA CÔNG NHÂN")
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.76, 0.32, 0.04),
      darkGlassMat
    );
    windshield.position.set(0, 0.7, 1.185);
    busGroup.add(windshield);

    const destVisor = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.075, 0.045),
      amberVisorMat
    );
    destVisor.position.set(0, 0.87, 1.19);
    busGroup.add(destVisor);

    // Hanging Coach Side-View Mirrors
    const armGeo = new THREE.BoxGeometry(0.1, 0.14, 0.05);
    const leftMirror = new THREE.Mesh(armGeo, darkTrimMat);
    leftMirror.position.set(0.46, 0.74, 1.12);
    const rightMirror = new THREE.Mesh(armGeo, darkTrimMat);
    rightMirror.position.set(-0.46, 0.74, 1.12);
    busGroup.add(leftMirror, rightMirror);

    // 3. Rooftop Heavy-Duty Air Conditioning Unit & Escape Hatches
    const acPod = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.11, 0.86),
      acPodMat
    );
    acPod.position.set(0, 0.99, -0.08);
    const hatch1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.04, 0.28),
      acPodMat
    );
    hatch1.position.set(0, 0.96, 0.68);
    const hatch2 = hatch1.clone();
    hatch2.position.z = -0.82;
    busGroup.add(acPod, hatch1, hatch2);

    // 4. 6 Cylindrical Wheels (Front Steer Axle + Twin Rear Axles)
    const tireGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.13, 10);
    rimGeo.rotateZ(Math.PI / 2);

    for (const wz of [0.74, -0.56, -0.92]) {
      for (const wx of [-0.41, 0.41]) {
        const tire = new THREE.Mesh(tireGeo, tireMat);
        tire.position.set(wx, 0.16, wz);
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.position.set(wx, 0.16, wz);
        busGroup.add(tire, rim);
      }
    }

    // 5. Front Headlights (+Z) & Vertical Rear Taillight Clusters (-Z)
    const headGeo = new THREE.BoxGeometry(0.15, 0.08, 0.04);
    const leftHead = new THREE.Mesh(headGeo, headlightMat);
    leftHead.position.set(0.28, 0.25, 1.19);
    const rightHead = new THREE.Mesh(headGeo, headlightMat);
    rightHead.position.set(-0.28, 0.25, 1.19);

    const tailGeo = new THREE.BoxGeometry(0.11, 0.18, 0.04);
    const leftTail = new THREE.Mesh(tailGeo, taillightMat);
    leftTail.position.set(0.33, 0.34, -1.19);
    const rightTail = new THREE.Mesh(tailGeo, taillightMat);
    rightTail.position.set(-0.33, 0.34, -1.19);

    busGroup.add(leftHead, rightHead, leftTail, rightTail);
    return busGroup;
  }

  /**
   * 3D Vietnamese Commuter Motorbike / Scooter with Seated Worker Rider (`Xe máy công nhân`)
   * Front & rear wheels with fenders, step-through fairing, handlebars, headlight, taillight,
   * PLUS a 3D seated rider (trousers/legs, worker uniform torso + safety stripe, arms on bars, rounded helmet).
   */
  _createMotorbikeMesh(
    bikeColor = 0xdc2626,
    helmetColor = 0x0284c7,
    shirtColor = 0x10b981
  ) {
    const bikeGroup = new THREE.Group();
    const bikeMat = this._getVehicleBodyMaterial(bikeColor, 0.3, 0.45);
    const helmetMat = this._getVehicleBodyMaterial(helmetColor, 0.24, 0.35);
    const shirtMat = this._getVehicleBodyMaterial(shirtColor, 0.65, 0.08);
    const {
      tireMat,
      rimMat,
      darkGlassMat,
      darkTrimMat,
      headlightMat,
      taillightMat,
      riderPantsMat,
      skinMat,
      safetyVestMat,
    } = this.vehicleShared;

    // 1. Front & Rear Wheels with Hubs and Fenders
    const tireGeo = new THREE.CylinderGeometry(0.125, 0.125, 0.055, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.072, 0.072, 0.062, 10);
    rimGeo.rotateZ(Math.PI / 2);

    const frontTire = new THREE.Mesh(tireGeo, tireMat);
    frontTire.position.set(0, 0.125, 0.33);
    const frontRim = new THREE.Mesh(rimGeo, rimMat);
    frontRim.position.set(0, 0.125, 0.33);

    const rearTire = new THREE.Mesh(tireGeo, tireMat);
    rearTire.position.set(0, 0.125, -0.31);
    const rearRim = new THREE.Mesh(rimGeo, rimMat);
    rearRim.position.set(0, 0.125, -0.31);
    bikeGroup.add(frontTire, frontRim, rearTire, rearRim);

    // Front mudguard fender & rear license plate fender
    const frontFender = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.045, 0.18),
      bikeMat
    );
    frontFender.position.set(0, 0.23, 0.32);
    frontFender.rotation.x = 0.28;
    const rearFender = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.1, 0.08),
      darkTrimMat
    );
    rearFender.position.set(0, 0.22, -0.42);
    rearFender.rotation.x = -0.45;
    bikeGroup.add(frontFender, rearFender);

    // Exhaust Muffler Pipe on right side
    const mufflerGeo = new THREE.CylinderGeometry(0.022, 0.028, 0.32, 8);
    mufflerGeo.rotateX(Math.PI / 2);
    const muffler = new THREE.Mesh(mufflerGeo, rimMat);
    muffler.position.set(-0.075, 0.14, -0.2);
    muffler.rotation.x = -0.14;
    bikeGroup.add(muffler);

    // 2. Step-Through Scooter Chassis, Front Leg-Shield Fairing & Seat
    const footboard = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.09, 0.36),
      darkTrimMat
    );
    footboard.position.set(0, 0.16, 0.01);
    bikeGroup.add(footboard);

    const frontFairing = new THREE.Mesh(
      new THREE.BoxGeometry(0.19, 0.28, 0.14),
      bikeMat
    );
    frontFairing.position.set(0, 0.29, 0.21);
    frontFairing.rotation.x = -0.28;
    frontFairing.castShadow = true;
    bikeGroup.add(frontFairing);

    const rearSideFairing = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.15, 0.38),
      bikeMat
    );
    rearSideFairing.position.set(0, 0.27, -0.2);
    rearSideFairing.rotation.x = 0.12;
    rearSideFairing.castShadow = true;
    bikeGroup.add(rearSideFairing);

    const seatMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.065, 0.36),
      darkTrimMat
    );
    seatMesh.position.set(0, 0.35, -0.18);
    bikeGroup.add(seatMesh);

    // 3. Angled Front Fork, Wide Handlebars, Mirrors, Headlight & Taillight
    const forkStem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.36, 8),
      rimMat
    );
    forkStem.position.set(0, 0.3, 0.26);
    forkStem.rotation.x = -0.32;
    bikeGroup.add(forkStem);

    const handlebar = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.032, 0.035),
      darkTrimMat
    );
    handlebar.position.set(0, 0.47, 0.2);
    bikeGroup.add(handlebar);

    const headlightPod = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.065, 0.06),
      headlightMat
    );
    headlightPod.position.set(0, 0.47, 0.25);
    const taillightPod = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.055, 0.04),
      taillightMat
    );
    taillightPod.position.set(0, 0.33, -0.4);
    bikeGroup.add(headlightPod, taillightPod);

    // 4. 3D Seated Worker Rider (Legs, Uniform Torso, Safety Stripe, Arms, Head & Rounded Helmet)
    const riderGroup = new THREE.Group();

    // Left & Right Legs seated on bike
    const thighGeo = new THREE.BoxGeometry(0.07, 0.08, 0.21);
    const calfGeo = new THREE.BoxGeometry(0.062, 0.16, 0.065);
    for (const sideSign of [-1, 1]) {
      const thigh = new THREE.Mesh(thighGeo, riderPantsMat);
      thigh.position.set(sideSign * 0.075, 0.38, -0.04);
      thigh.rotation.x = 0.25;
      const calf = new THREE.Mesh(calfGeo, riderPantsMat);
      calf.position.set(sideSign * 0.08, 0.26, 0.05);
      calf.rotation.x = -0.2;
      riderGroup.add(thigh, calf);
    }

    // Worker Jacket Torso + High-Vis Reflective Vest Band
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.21, 0.25, 0.13),
      shirtMat
    );
    torso.position.set(0, 0.51, -0.1);
    torso.rotation.x = 0.18;
    torso.castShadow = true;
    riderGroup.add(torso);

    const safetyBand = new THREE.Mesh(
      new THREE.BoxGeometry(0.216, 0.055, 0.136),
      safetyVestMat
    );
    safetyBand.position.set(0, 0.5, -0.1);
    safetyBand.rotation.x = 0.18;
    riderGroup.add(safetyBand);

    // Left & Right Arms reaching forward to handlebars
    const armGeo = new THREE.BoxGeometry(0.052, 0.052, 0.24);
    for (const sideSign of [-1, 1]) {
      const arm = new THREE.Mesh(armGeo, shirtMat);
      arm.position.set(sideSign * 0.125, 0.52, 0.04);
      arm.rotation.x = 0.22;
      arm.rotation.y = -sideSign * 0.14;
      riderGroup.add(arm);
    }

    // Head & Rounded 3/4 Vietnamese Motorbike Helmet with Front Visor
    const headMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.072, 10, 10),
      skinMat
    );
    headMesh.position.set(0, 0.68, -0.07);
    riderGroup.add(headMesh);

    const helmetShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.095, 14, 12),
      helmetMat
    );
    helmetShell.position.set(0, 0.705, -0.075);
    helmetShell.scale.set(0.95, 1.0, 1.08);
    helmetShell.castShadow = true;
    riderGroup.add(helmetShell);

    const helmetVisor = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.05, 0.05),
      darkGlassMat
    );
    helmetVisor.position.set(0, 0.695, 0.01);
    riderGroup.add(helmetVisor);

    bikeGroup.add(riderGroup);
    return bikeGroup;
  }

  /* ==========================================================================
   * 5. REGIONAL HIGHWAY NETWORK & LEVEL 1 3D VEHICLE FLEETS
   * ========================================================================== */

  _buildHighwayNetwork(provinces, kcns) {
    const { center, span, scale } = this.worldBounds;
    const s = Math.max(scale, 0.5);

    const byProv = new Map();
    for (const kcn of kcns) {
      const code = kcn.province_code || 'OTHER';
      if (!byProv.has(code)) byProv.set(code, []);
      byProv.get(code).push(toVec3(kcn.worldPosition));
    }

    const avgPos = (pts, fallback) => {
      if (!pts || pts.length === 0) return fallback.clone();
      const sum = new THREE.Vector3();
      pts.forEach((p) => sum.add(p));
      return sum.divideScalar(pts.length);
    };

    const hanoiHub = new THREE.Vector3(center.x, 0.14 * s, center.z + span * 0.24);
    const vpCenter = avgPos(
      byProv.get('VP') || byProv.get('VINH_PHUC'),
      new THREE.Vector3(center.x - span * 0.08, 0.14 * s, center.z - span * 0.06)
    );
    const ptCenter = avgPos(
      byProv.get('PT') || byProv.get('PHU_THO'),
      new THREE.Vector3(center.x - span * 0.36, 0.14 * s, center.z - span * 0.16)
    );
    const bgCenter = avgPos(
      byProv.get('BG') || byProv.get('BAC_GIANG'),
      new THREE.Vector3(center.x + span * 0.36, 0.14 * s, center.z - span * 0.08)
    );
    const hbCenter = avgPos(
      byProv.get('HB') || byProv.get('HOA_BINH'),
      new THREE.Vector3(center.x - span * 0.28, 0.14 * s, center.z + span * 0.34)
    );

    let highwayCorridors = [];
    const extPolylines =
      this.hierarchyData?.highways ||
      this.externalGeoProjection?.HIGHWAY_POLYLINES ||
      null;

    if (Array.isArray(extPolylines) && extPolylines.length > 0) {
      for (const hw of extPolylines) {
        const rawPts = Array.isArray(hw.worldPoints)
          ? hw.worldPoints
          : Array.isArray(hw.points)
            ? hw.points
            : Array.isArray(hw.latLngs)
              ? hw.latLngs.map((ll) => {
                  const p = this._latLngToWorld(ll[0], ll[1]);
                  return [p.x, 0.14 * s, p.z];
                })
              : [];
        if (rawPts.length >= 2) {
          highwayCorridors.push({
            name: hw.name || hw.code || 'Cao tốc',
            color: parseHexColor(hw.color, 0x0284c7),
            points: rawPts.map((pt) => {
              const v = toVec3(pt);
              v.y = 0.14 * s;
              return v;
            }),
          });
        }
      }
    }

    if (highwayCorridors.length === 0) {
      highwayCorridors = [
        {
          name: 'CT.05 Nội Bài – Lào Cai',
          color: 0x0284c7,
          points: [
            hanoiHub.clone(),
            vpCenter.clone().add(new THREE.Vector3(0, 0, 8 * s)),
            ptCenter.clone(),
            ptCenter.clone().add(new THREE.Vector3(-28 * s, 0, -20 * s)),
          ],
        },
        {
          name: 'CT.01 Hà Nội – Bắc Giang',
          color: 0x10b981,
          points: [
            hanoiHub.clone(),
            new THREE.Vector3(
              (hanoiHub.x + bgCenter.x) * 0.5,
              0.14 * s,
              (hanoiHub.z + bgCenter.z) * 0.5
            ),
            bgCenter.clone(),
            bgCenter.clone().add(new THREE.Vector3(26 * s, 0, -18 * s)),
          ],
        },
        {
          name: 'QL18 Nội Bài – Bắc Giang',
          color: 0xf59e0b,
          points: [
            vpCenter.clone(),
            new THREE.Vector3(
              (vpCenter.x + bgCenter.x) * 0.5,
              0.14 * s,
              (vpCenter.z + bgCenter.z) * 0.5 - 6 * s
            ),
            bgCenter.clone(),
          ],
        },
        {
          name: 'QL6 Hà Nội – Hòa Bình',
          color: 0xea580c,
          points: [
            hanoiHub.clone(),
            new THREE.Vector3(
              (hanoiHub.x + hbCenter.x) * 0.5,
              0.14 * s,
              (hanoiHub.z + hbCenter.z) * 0.5
            ),
            hbCenter.clone(),
          ],
        },
      ];
    }

    const roadBedMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.72,
      metalness: 0.15,
    });

    const carColors = [0x2563eb, 0xf8fafc, 0xdc2626, 0x0f172a, 0x059669, 0xd97706];
    const busStripes = [0x0284c7, 0x10b981, 0xea580c, 0x4f46e5];
    const bikeColors = [0xdc2626, 0x0284c7, 0x16a34a, 0xf59e0b];

    for (const corridor of highwayCorridors) {
      const curve = new THREE.CatmullRomCurve3(corridor.points);

      // Asphalt highway ribbon
      const bedGeo = new THREE.TubeGeometry(curve, 72, 1.55 * s, 8, false);
      bedGeo.scale(1, 0.12, 1);
      const bedMesh = new THREE.Mesh(bedGeo, roadBedMat);
      bedMesh.position.y = 0.08 * s;
      bedMesh.receiveShadow = true;
      this.highwayGroup.add(bedMesh);

      // Glowing center expressway median spline line
      const lineGeo = new THREE.TubeGeometry(curve, 72, 0.22 * s, 6, false);
      lineGeo.scale(1, 0.35, 1);
      const lineMat = new THREE.MeshStandardMaterial({
        color: corridor.color,
        emissive: corridor.color,
        emissiveIntensity: 0.65,
        roughness: 0.3,
        transparent: true,
        opacity: 0.88,
      });
      this.dynamicEmissiveMaterials.push({
        material: lineMat,
        dayIntensity: 0.45,
        nightIntensity: 1.45,
      });
      const lineMesh = new THREE.Mesh(lineGeo, lineMat);
      lineMesh.position.y = 0.2 * s;
      this.highwayGroup.add(lineMesh);

      // Spawn compact 3D miniature cars, worker shuttle buses & motorbikes along the regional highway
      const vehicleCount = 6;
      const hwScale = 0.72 * s;
      for (let i = 0; i < vehicleCount; i++) {
        const isReverse = i % 2 === 1;
        let vMesh;
        let laneRightOffset = 0.46 * s;
        const baseSpeed = 0.034;

        if (i === 0) {
          vMesh = this._createShuttleBusMesh(
            0xf8fafc,
            busStripes[i % busStripes.length]
          );
        } else if (i === 3) {
          vMesh = this._createMotorbikeMesh(
            bikeColors[i % bikeColors.length],
            0x0284c7,
            0x10b981
          );
          laneRightOffset = 0.68 * s;
        } else {
          vMesh = this._createCarMesh(
            carColors[i % carColors.length],
            i % 3 === 0 ? 'suv' : 'sedan'
          );
        }

        vMesh.scale.setScalar(hwScale);
        this.highwayGroup.add(vMesh);

        this.trafficVehicles.push({
          mesh: vMesh,
          curve,
          t: (i / vehicleCount) % 1,
          speed: baseSpeed * (isReverse ? -1 : 1),
          laneRightOffset,
          heightOffset: 0.21 * s,
          bobPhase: i * 1.3,
          scope: 'highway',
        });
      }
    }
  }

  /* ==========================================================================
   * 6. LEVEL 1 & LEVEL 2: REAL KCN POLYGON COMPOUNDS, ZOOM-15 MAP PADS & 3D TRAFFIC
   * ========================================================================== */

  _buildAllKcnCompounds(kcns) {
    const positions = kcns.map((k) => toVec3(k.worldPosition));

    kcns.forEach((kcn, idx) => {
      const pos = positions[idx];
      let minNeighborDist = Infinity;
      positions.forEach((otherPos, otherIdx) => {
        if (idx === otherIdx) return;
        const d = pos.distanceTo(otherPos);
        if (d > 0.1 && d < minNeighborDist) minNeighborDist = d;
      });
      if (!Number.isFinite(minNeighborDist)) {
        minNeighborDist = 48 * Math.max(this.worldBounds.scale, 0.6);
      }

      this._buildSingleKcnCompound(kcn, pos, minNeighborDist, idx);
    });
  }

  /**
   * Resolves a realistic 6-to-10-vertex local `[x, z]` polygon boundary for a KCN
   * from `kcn.boundaryPolygon`, `kcn.boundaryLatLng`, or a deterministic architectural KCN master-plan polygon.
   */
  _resolveKcnLocalBoundaryPolygon(kcn, kcnWorldPos, padHalfW, padHalfD, kcnIdx = 0) {
    const rawPoly = Array.isArray(kcn.boundaryPolygon) ? kcn.boundaryPolygon : null;
    if (rawPoly && rawPoly.length >= 4) {
      // Determine whether boundaryPolygon is local (centroid ~ 0,0) or world (centroid ~ kcnWorldPos)
      let sumX = 0;
      let sumZ = 0;
      for (const pt of rawPoly) {
        sumX += Number(Array.isArray(pt) ? pt[0] : pt.x) || 0;
        sumZ += Number(Array.isArray(pt) ? pt[1] ?? pt[2] : pt.z) || 0;
      }
      const avgX = sumX / rawPoly.length;
      const avgZ = sumZ / rawPoly.length;
      const isLocal = Math.hypot(avgX, avgZ) < 12;

      const localPts = rawPoly.map((pt) => {
        const px = Number(Array.isArray(pt) ? pt[0] : pt.x) || 0;
        const pz = Number(Array.isArray(pt) ? pt[1] ?? pt[2] : pt.z) || 0;
        return [isLocal ? px : px - kcnWorldPos.x, isLocal ? pz : pz - kcnWorldPos.z];
      });

      // Ensure polygon encompasses all company plots (`padHalfW, padHalfD`)
      let maxAbsX = 1;
      let maxAbsZ = 1;
      for (const [lx, lz] of localPts) {
        if (Math.abs(lx) > maxAbsX) maxAbsX = Math.abs(lx);
        if (Math.abs(lz) > maxAbsZ) maxAbsZ = Math.abs(lz);
      }
      const scaleX = maxAbsX < padHalfW * 0.92 ? padHalfW / maxAbsX : 1;
      const scaleZ = maxAbsZ < padHalfD * 0.92 ? padHalfD / maxAbsZ : 1;
      return localPts.map(([lx, lz]) => [lx * scaleX, lz * scaleZ]);
    }

    // Deterministic 8-vertex industrial park polygon with angled highway frontage & chamfered corners
    const w = padHalfW;
    const d = padHalfD;
    const c1 = Math.min(w, d) * (0.18 + (kcnIdx % 3) * 0.04);
    const c2 = Math.min(w, d) * (0.24 - (kcnIdx % 2) * 0.05);
    const skewX = ((kcnIdx % 3) - 1) * 2.2;

    return [
      [-w + c1, -d],
      [w * 0.35 + skewX, -d * 1.04],
      [w, -d + c2],
      [w * 1.03, d * 0.25],
      [w - c1 * 0.85, d],
      [-w * 0.38 + skewX, d * 1.02],
      [-w, d - c2],
      [-w * 1.02, -d * 0.28],
    ];
  }

  _buildSingleKcnCompound(kcn, kcnWorldPos, minNeighborDist, kcnIdx = 0) {
    const kcnCode = kcn.industrial_park_code;
    const companies = Array.isArray(kcn.companies) ? kcn.companies : [];
    const isActive = (Number(kcn.job_count) || companies.length) > 0;
    const s = 1.0;

    const kcnGroup = new THREE.Group();
    kcnGroup.name = `KCN_${kcnCode}`;
    kcnGroup.position.copy(kcnWorldPos);
    this.kcnRootGroup.add(kcnGroup);

    // Resolve each company's local plot position & dimensions relative to kcnWorldPos
    const resolvedPlots = companies.map((comp, idx) => {
      let localPos;
      if (Array.isArray(comp.plotLocalPosition) && comp.plotLocalPosition.length >= 3) {
        localPos = toVec3(comp.plotLocalPosition);
      } else if (Array.isArray(comp.plotWorldPosition) && comp.plotWorldPosition.length >= 3) {
        const wp = toVec3(comp.plotWorldPosition);
        localPos = wp.sub(kcnWorldPos);
      } else {
        const col = idx % 3;
        const row = Math.floor(idx / 3);
        localPos = new THREE.Vector3((col - 1) * 14, 0, row === 0 ? -9.5 : 9.5);
      }

      const rawDims = Array.isArray(comp.buildingDimensions)
        ? comp.buildingDimensions
        : [8.5, 5.2, 6.2];
      const dims = [
        Math.max(Number(rawDims[0]) || 8.0, 4.5),
        Math.max(Number(rawDims[1]) || 4.8, 3.2),
        Math.max(Number(rawDims[2]) || 5.8, 4.0),
      ];

      return {
        company: comp,
        localPos,
        dims,
      };
    });

    const rawPadDims = Array.isArray(kcn.padDimensions) ? kcn.padDimensions : [56, 36];
    let maxExtentX = (Number(rawPadDims[0]) || 56) * 0.5 - 4.0;
    let maxExtentZ = (Number(rawPadDims[1]) || 36) * 0.5 - 3.5;
    for (const p of resolvedPlots) {
      const ex = Math.abs(p.localPos.x) + p.dims[0] * 0.72;
      const ez = Math.abs(p.localPos.z) + p.dims[2] * 0.72;
      if (ex > maxExtentX) maxExtentX = ex;
      if (ez > maxExtentZ) maxExtentZ = ez;
    }

    const padHalfW = maxExtentX + 5.2;
    const padHalfD = maxExtentZ + 4.8;
    const padHeight = 0.65;

    // 1. Real KCN Polygon Shape Foundation Pad & Pickable Surface
    const polyPts = this._resolveKcnLocalBoundaryPolygon(
      kcn,
      kcnWorldPos,
      padHalfW,
      padHalfD,
      kcnIdx
    );

    const kcnShape = new THREE.Shape();
    polyPts.forEach(([px, pz], i) => {
      // Note: rotateX(-Math.PI/2) maps shape (x, y) -> 3D (x, 0, -y), so pass -pz as y
      if (i === 0) kcnShape.moveTo(px, -pz);
      else kcnShape.lineTo(px, -pz);
    });
    kcnShape.closePath();

    const padMat = new THREE.MeshStandardMaterial({
      color: PALETTE.day.kcnPadBase.clone(),
      roughness: 0.78,
      metalness: 0.1,
    });

    const extrudeGeo = new THREE.ExtrudeGeometry(kcnShape, {
      depth: padHeight,
      bevelEnabled: false,
    });
    extrudeGeo.rotateX(-Math.PI / 2);

    const padMesh = new THREE.Mesh(extrudeGeo, padMat);
    padMesh.receiveShadow = true;
    padMesh.userData.pickNode = {
      type: 'kcn',
      key: kcnCode,
      kcnCode,
      data: kcn,
    };
    kcnGroup.add(padMesh);
    this.pickableMeshes.push(padMesh);

    // 2. High-Zoom (`zoom = 15`) Real Map Tile Draped Surface clipped to KCN Polygon!
    let polyMinX = Infinity;
    let polyMaxX = -Infinity;
    let polyMinZ = Infinity;
    let polyMaxZ = -Infinity;
    for (const [px, pz] of polyPts) {
      if (px < polyMinX) polyMinX = px;
      if (px > polyMaxX) polyMaxX = px;
      if (pz < polyMinZ) polyMinZ = pz;
      if (pz > polyMaxZ) polyMaxZ = pz;
    }

    const mapSurfaceGeo = new THREE.ShapeGeometry(kcnShape);
    mapSurfaceGeo.rotateX(-Math.PI / 2);

    // Assign exact planar UVs [0..1] across the KCN polygon bounding box
    const posAttr = mapSurfaceGeo.attributes.position;
    const uvAttr = mapSurfaceGeo.attributes.uv;
    const spanPolyX = Math.max(polyMaxX - polyMinX, 1);
    const spanPolyZ = Math.max(polyMaxZ - polyMinZ, 1);
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const u = (vx - polyMinX) / spanPolyX;
      const v = 1.0 - (vz - polyMinZ) / spanPolyZ;
      uvAttr.setXY(i, u, v);
    }
    uvAttr.needsUpdate = true;

    const mapPadState = this._createKcnMapPadTextureState(kcn, polyMinX, polyMaxX, polyMinZ, polyMaxZ);
    const mapSurfaceMesh = new THREE.Mesh(mapSurfaceGeo, mapPadState.material);
    mapSurfaceMesh.position.y = padHeight + 0.012;
    mapSurfaceMesh.receiveShadow = true;
    mapSurfaceMesh.userData.pickNode = padMesh.userData.pickNode;
    kcnGroup.add(mapSurfaceMesh);
    this.pickableMeshes.push(mapSurfaceMesh);

    // 3. Glowing 3D Polygon Perimeter Curb Wall (`kcnActiveBorder` for active, slate when 0 jobs)
    const baseBorderColor = isActive
      ? this.activeSkinTokens.kcnActiveBorder
      : PALETTE.slateInactive;
    const borderMat = new THREE.MeshStandardMaterial({
      color: baseBorderColor,
      emissive: baseBorderColor,
      emissiveIntensity: isActive ? 0.85 : 0.2,
      roughness: 0.25,
      metalness: 0.3,
    });

    const curbThickness = 0.44 * s;
    const curbHeight = padHeight + 0.18 * s;
    for (let i = 0; i < polyPts.length; i++) {
      const [x1, z1] = polyPts[i];
      const [x2, z2] = polyPts[(i + 1) % polyPts.length];
      const segLen = Math.hypot(x2 - x1, z2 - z1);
      if (segLen < 0.2) continue;
      const segMesh = new THREE.Mesh(
        new THREE.BoxGeometry(segLen + curbThickness * 0.6, curbHeight, curbThickness),
        borderMat
      );
      segMesh.position.set((x1 + x2) * 0.5, curbHeight * 0.5, (z1 + z2) * 0.5);
      segMesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      kcnGroup.add(segMesh);
    }

    // 4. Internal Asphalt Boulevard Network, Crosswalks, Gatehouse & Realistic 3D Vehicle Traffic!
    this._buildKcnInternalRoadsAndTraffic(
      kcnGroup,
      kcn,
      padHalfW,
      padHalfD,
      padHeight,
      s,
      isActive,
      kcnIdx
    );

    // 5. Build Company Plot Facilities (or Architectural Massing Silhouettes if 0 active jobs)
    const kcnCompanyRecords = [];
    if (resolvedPlots.length > 0) {
      for (const plot of resolvedPlots) {
        const compRecord = this._buildCompanyFacilityOnPlot(
          kcnGroup,
          kcn,
          plot.company,
          plot.localPos,
          plot.dims,
          padHeight,
          s
        );
        kcnCompanyRecords.push(compRecord);
      }
    } else {
      this._buildPlaceholderMassingBlocks(kcnGroup, padHalfW, padHalfD, padHeight, s);
    }

    const maxBuildingH = resolvedPlots.reduce((acc, p) => Math.max(acc, p.dims[1]), 6 * s);
    const anchorLocalY = padHeight + maxBuildingH + 4.5 * s;

    this.kcnRecords.set(kcnCode, {
      kcnCode,
      data: kcn,
      group: kcnGroup,
      worldPos: kcnWorldPos.clone(),
      padHalfW,
      padHalfD,
      padHeight,
      padMat,
      borderMat,
      baseBorderColor,
      isActive,
      mapPadState,
      anchorWorldPos: new THREE.Vector3(
        kcnWorldPos.x,
        kcnWorldPos.y + anchorLocalY,
        kcnWorldPos.z
      ),
      hoverMix: 0,
      companyRecords: kcnCompanyRecords,
    });
  }

  /**
   * Creates an offscreen 768x768 CanvasTexture for a KCN polygon pad that stitches
   * high-zoom (`zoom = 15`) real map tiles from `/api/map-tile?style=street|satellite&z=15&x=...&y=...`.
   */
  _createKcnMapPadTextureState(kcn, minX, maxX, minZ, maxZ) {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');

    // Initial crisp architectural master-plan base fill before high-zoom network tiles arrive
    ctx.fillStyle = '#e8eef5';
    ctx.fillRect(0, 0, 768, 768);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.16)';
    ctx.lineWidth = 1;
    for (let g = 64; g < 768; g += 64) {
      ctx.beginPath();
      ctx.moveTo(g, 0);
      ctx.lineTo(g, 768);
      ctx.moveTo(0, g);
      ctx.lineTo(768, g);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8);

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.05,
    });

    return {
      canvas,
      ctx,
      texture,
      material,
      minX,
      maxX,
      minZ,
      maxZ,
      isLoaded: false,
      loadedStyle: null,
    };
  }

  /**
   * Stitches a 3x3 grid of `zoom = 15` real geographic map tiles centered on `(kcn.lat, kcn.lng)`
   * directly onto the KCN pad's `CanvasTexture`.
   */
  _loadKcnHighZoomMapCanvas(kcnRec, style = this.mapStyle) {
    if (!this.tileOrigin || !kcnRec?.mapPadState) return;
    const state = kcnRec.mapPadState;
    const targetStyle = style === 'satellite' ? 'satellite' : 'street';
    if (state.loadedStyle === targetStyle && state.isLoaded) return;

    state.loadedStyle = targetStyle;
    state.isLoaded = true;

    const tilePixels = 256;
    const { ctx, texture } = state;

    const ext = this.externalGeoProjection;
    if (ext && typeof ext.getKcnMapTileGrid === 'function') {
      try {
        const grid = ext.getKcnMapTileGrid(kcnRec.data, {
          zoom: 15,
          style: targetStyle,
          radiusTiles: 1,
        });
        if (Array.isArray(grid?.tiles) && grid.tiles.length > 0) {
          for (const t of grid.tiles) {
            const drawX = (Number(t.col) || 0) * tilePixels;
            const drawY = (Number(t.row) || 0) * tilePixels;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              if (this.isDisposed || state.loadedStyle !== targetStyle) return;
              ctx.drawImage(img, drawX, drawY, tilePixels, tilePixels);
              texture.needsUpdate = true;
            };
            img.src = this._buildTileUrl(targetStyle, t.z || 15, t.x, t.y);
          }
          return;
        }
      } catch {
        // Fallback below
      }
    }

    const zoom = 15;
    const lat = Number(kcnRec.data?.lat) || 21.3188;
    const lng = Number(kcnRec.data?.lng) || 105.6865;
    const centerTile = latLngToTileFloat(lat, lng, zoom);
    const centerTX = Math.floor(centerTile.x);
    const centerTY = Math.floor(centerTile.y);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = centerTX + dx;
        const ty = centerTY + dy;
        const url = this._buildTileUrl(targetStyle, zoom, tx, ty);
        const drawX = (dx + 1) * tilePixels;
        const drawY = (dy + 1) * tilePixels;

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (this.isDisposed || state.loadedStyle !== targetStyle) return;
          ctx.drawImage(img, drawX, drawY, tilePixels, tilePixels);
          texture.needsUpdate = true;
        };
        img.src = url;
      }
    }
  }

  _buildKcnInternalRoadsAndTraffic(
    kcnGroup,
    kcn,
    padHalfW,
    padHalfD,
    padHeight,
    s,
    isActive,
    kcnIdx = 0
  ) {
    const roadY = padHeight + 0.035 * s;
    const roadMat = new THREE.MeshStandardMaterial({
      color: PALETTE.asphaltRoad,
      roughness: 0.85,
      metalness: 0.1,
    });
    const markingMat = new THREE.MeshBasicMaterial({
      color: PALETTE.roadMarking,
      transparent: true,
      opacity: 0.78,
    });

    // 1. Main East-West Boulevard along z = 0 (width 4.2u for smooth 2-way 3D vehicle traffic)
    const roadW = 4.2 * s;
    const boulevardLen = padHalfW * 1.82;
    const ewRoad = new THREE.Mesh(
      new THREE.PlaneGeometry(boulevardLen, roadW),
      roadMat
    );
    ewRoad.rotation.x = -Math.PI / 2;
    ewRoad.position.set(0, roadY, 0);
    ewRoad.receiveShadow = true;
    kcnGroup.add(ewRoad);

    // Twin North-South cross-avenues at x = ±7
    const crossAvenueW = 2.6 * s;
    const crossAvenueLen = padHalfD * 1.78;
    for (const crossX of [-7 * s, 7 * s]) {
      const nsRoad = new THREE.Mesh(
        new THREE.PlaneGeometry(crossAvenueW, crossAvenueLen),
        roadMat
      );
      nsRoad.rotation.x = -Math.PI / 2;
      nsRoad.position.set(crossX, roadY + 0.005 * s, 0);
      nsRoad.receiveShadow = true;
      kcnGroup.add(nsRoad);
    }

    // Perimeter Ring Road connecting cross-avenues & South Entrance Plaza
    const entrancePlaza = new THREE.Mesh(
      new THREE.PlaneGeometry(17.5 * s, 3.2 * s),
      roadMat
    );
    entrancePlaza.rotation.x = -Math.PI / 2;
    entrancePlaza.position.set(0, roadY + 0.006 * s, padHalfD - 2.3 * s);
    kcnGroup.add(entrancePlaza);

    // Dashed white center lane markings along East-West boulevard
    const dashCount = 8;
    const dashLen = (boulevardLen * 0.88) / (dashCount * 2);
    const dashGeo = new THREE.PlaneGeometry(dashLen, 0.16 * s);
    dashGeo.rotateX(-Math.PI / 2);
    for (let i = -dashCount + 1; i < dashCount; i++) {
      if (i === 0) continue;
      const dash = new THREE.Mesh(dashGeo, markingMat);
      dash.position.set(i * dashLen * 1.75, roadY + 0.02 * s, 0);
      kcnGroup.add(dash);
    }

    // Zebra Pedestrian Crosswalks at main boulevard intersections (x = ±5.2)
    const stripeGeo = new THREE.PlaneGeometry(0.65 * s, 0.24 * s);
    stripeGeo.rotateX(-Math.PI / 2);
    for (const cwX of [-5.2 * s, 5.2 * s]) {
      for (let sz = -1.5; sz <= 1.5; sz += 0.5) {
        const stripe = new THREE.Mesh(stripeGeo, markingMat);
        stripe.position.set(cwX, roadY + 0.022 * s, sz * s);
        kcnGroup.add(stripe);
      }
    }

    // 2. Main KCN Entrance Gatehouse Arch on the South (+Z) Perimeter
    const gateGroup = new THREE.Group();
    gateGroup.position.set(0, padHeight, padHalfD - 0.8 * s);

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.38,
      metalness: 0.28,
    });
    const pillarW = 0.55 * s;
    const pillarH = 2.8 * s;
    const spanW = roadW + 2.0 * s;

    const leftPillar = new THREE.Mesh(
      new THREE.BoxGeometry(pillarW, pillarH, pillarW),
      pillarMat
    );
    leftPillar.position.set(-spanW * 0.5, pillarH * 0.5, 0);
    const rightPillar = leftPillar.clone();
    rightPillar.position.x = spanW * 0.5;

    const canopyGeo = new THREE.BoxGeometry(spanW + pillarW * 1.8, 0.52 * s, 1.3 * s);
    const canopyMesh = new THREE.Mesh(canopyGeo, pillarMat);
    canopyMesh.position.set(0, pillarH + 0.2 * s, 0);

    const signMat = new THREE.MeshStandardMaterial({
      color: isActive ? this.activeSkinTokens.primary : PALETTE.slateInactive,
      emissive: isActive ? this.activeSkinTokens.primary : PALETTE.slateInactive,
      emissiveIntensity: 0.9,
      roughness: 0.2,
    });
    if (isActive) {
      this.skinAccentMaterials.push({
        material: signMat,
        role: 'primary',
        updateEmissive: true,
      });
    }
    this.dynamicEmissiveMaterials.push({
      material: signMat,
      dayIntensity: 0.55,
      nightIntensity: 1.65,
    });
    const signStrip = new THREE.Mesh(
      new THREE.BoxGeometry(spanW + 0.2 * s, 0.22 * s, 1.36 * s),
      signMat
    );
    signStrip.position.set(0, pillarH + 0.22 * s, 0);

    gateGroup.add(leftPillar, rightPillar, canopyMesh, signStrip);
    kcnGroup.add(gateGroup);

    // 3. Perimeter Trees & Streetlamps along the boulevard
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9 });
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.72 });
    const lampHeadMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xfbbf24,
      emissiveIntensity: 0.2,
    });
    this.streetLampMaterials.push(lampHeadMat);

    const treePositions = [
      [-padHalfW * 0.76, -padHalfD * 0.76],
      [padHalfW * 0.76, -padHalfD * 0.76],
      [-padHalfW * 0.76, padHalfD * 0.76],
      [padHalfW * 0.76, padHalfD * 0.76],
      [-padHalfW * 0.45, roadW * 0.78],
      [padHalfW * 0.45, roadW * 0.78],
      [-padHalfW * 0.45, -roadW * 0.78],
      [padHalfW * 0.45, -roadW * 0.78],
    ];

    const trunkGeo = new THREE.CylinderGeometry(0.12 * s, 0.16 * s, 0.8 * s, 6);
    const crownGeo = new THREE.ConeGeometry(0.65 * s, 1.55 * s, 7);
    const poleGeo = new THREE.CylinderGeometry(0.06 * s, 0.08 * s, 1.9 * s, 6);
    const bulbGeo = new THREE.SphereGeometry(0.18 * s, 8, 8);

    treePositions.forEach(([tx, tz], idx) => {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(tx, padHeight + 0.4 * s, tz);
      const crown = new THREE.Mesh(crownGeo, foliageMat);
      crown.position.set(tx, padHeight + 1.35 * s, tz);
      crown.castShadow = true;
      kcnGroup.add(trunk, crown);

      if (idx >= 4) {
        const pole = new THREE.Mesh(poleGeo, trunkMat);
        pole.position.set(tx * 0.72, padHeight + 0.95 * s, tz);
        const bulb = new THREE.Mesh(bulbGeo, lampHeadMat);
        bulb.position.set(tx * 0.72, padHeight + 1.92 * s, tz);
        kcnGroup.add(pole, bulb);
      }
    });

    // 4. Spawn Lively 3D Miniature Cars, Worker Shuttle Buses & Motorbikes inside the KCN!
    this._spawnKcnInternalTraffic(
      kcnGroup,
      padHalfW,
      padHalfD,
      roadY,
      boulevardLen,
      crossAvenueLen,
      isActive,
      kcnIdx
    );
  }

  /**
   * Spawns a clean, well-proportioned fleet of 4-5 compact 3D vehicles (1 shuttle bus, 2 cars, 2 single motorbikes)
   * driving strictly straight (never diagonally) along the horizontal main boulevard and vertical cross-avenue.
   */
  _spawnKcnInternalTraffic(
    kcnGroup,
    padHalfW,
    padHalfD,
    roadY,
    boulevardLen,
    crossAvenueLen,
    isActive,
    kcnIdx = 0
  ) {
    const kcnCode = String(kcnGroup?.name || '').replace(/^KCN_/, '');
    const halfSpanX = boulevardLen * 0.46;
    const halfSpanZ = crossAvenueLen * 0.44;

    // Straight Horizontal Main Boulevard along z = 0 (dz = 0 -> rotation.y is strictly +PI/2 or -PI/2)
    const ewStraightLine = new THREE.LineCurve3(
      new THREE.Vector3(-halfSpanX, roadY, 0),
      new THREE.Vector3(halfSpanX, roadY, 0)
    );

    // Straight Vertical Cross-Avenue along x = 7 (dx = 0 -> rotation.y is strictly 0 or PI)
    const nsStraightLine = new THREE.LineCurve3(
      new THREE.Vector3(7, roadY, -halfSpanZ),
      new THREE.Vector3(7, roadY, halfSpanZ)
    );

    const carColors = [0x2563eb, 0xffffff, 0xdc2626, 0x0f172a, 0x059669, 0xd97706];
    const busStripes = [0x0284c7, 0xea580c, 0x10b981, 0x4f46e5];
    const bikePalettes = [
      { bike: 0xdc2626, helmet: 0x0284c7, shirt: 0x38bdf8 },
      { bike: 0x1e40af, helmet: 0xfacc15, shirt: 0x10b981 },
      { bike: 0xf8fafc, helmet: 0xef4444, shirt: 0xf97316 },
      { bike: 0x059669, helmet: 0xffffff, shirt: 0x2563eb },
    ];

    // 4 vehicles on the straight horizontal main boulevard (2 Eastbound +X, 2 Westbound -X)
    const boulevardSpecs = isActive
      ? [
          { type: 'bus', t: 0.14, dir: 1, lane: 0.86, speed: 0.054, scale: 0.5, stripe: busStripes[kcnIdx % 4] },
          { type: 'car', t: 0.64, dir: 1, lane: 0.86, speed: 0.054, scale: 0.52, color: carColors[(kcnIdx + 1) % 6], variant: 'sedan' },
          { type: 'car', t: 0.28, dir: -1, lane: 0.86, speed: 0.058, scale: 0.52, color: carColors[(kcnIdx + 2) % 6], variant: 'suv' },
          { type: 'bike', t: 0.78, dir: -1, lane: 1.04, speed: 0.058, scale: 0.54, pal: bikePalettes[kcnIdx % 4] },
        ]
      : [
          { type: 'car', t: 0.25, dir: 1, lane: 0.86, speed: 0.052, scale: 0.52, color: carColors[kcnIdx % 6], variant: 'sedan' },
          { type: 'bike', t: 0.72, dir: -1, lane: 1.02, speed: 0.054, scale: 0.54, pal: bikePalettes[kcnIdx % 4] },
        ];

    for (let i = 0; i < boulevardSpecs.length; i++) {
      const spec = boulevardSpecs[i];
      let mesh;
      if (spec.type === 'bus') {
        mesh = this._createShuttleBusMesh(0xf8fafc, spec.stripe);
      } else if (spec.type === 'bike') {
        mesh = this._createMotorbikeMesh(spec.pal.bike, spec.pal.helmet, spec.pal.shirt);
      } else {
        mesh = this._createCarMesh(spec.color, spec.variant);
      }

      mesh.scale.setScalar(spec.scale);
      kcnGroup.add(mesh);

      this.trafficVehicles.push({
        mesh,
        curve: ewStraightLine,
        t: spec.t,
        speed: spec.speed * spec.dir,
        laneRightOffset: spec.lane,
        heightOffset: 0.01,
        bobPhase: i * 1.1,
        scope: 'kcn',
        kcnCode,
        roadAxis: 'horizontal',
      });
    }

    // 5th vehicle on the straight vertical North-South cross-avenue (dx = 0 -> strictly straight along Z)
    if (isActive) {
      const pal = bikePalettes[(kcnIdx + 1) % 4];
      const nsBike = this._createMotorbikeMesh(pal.bike, pal.helmet, pal.shirt);
      nsBike.scale.setScalar(0.54);
      kcnGroup.add(nsBike);

      this.trafficVehicles.push({
        mesh: nsBike,
        curve: nsStraightLine,
        t: 0.42,
        speed: -0.056,
        laneRightOffset: 0.52,
        heightOffset: 0.012,
        bobPhase: 2.4,
        scope: 'kcn',
        kcnCode,
        roadAxis: 'vertical',
      });
    }
  }

  _buildPlaceholderMassingBlocks(kcnGroup, padHalfW, padHalfD, padHeight, s) {
    const ghostMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.72,
      metalness: 0.18,
      transparent: true,
      opacity: 0.52,
    });
    const offsets = [
      [-padHalfW * 0.42, -padHalfD * 0.38],
      [padHalfW * 0.42, -padHalfD * 0.38],
      [-padHalfW * 0.42, padHalfD * 0.38],
      [padHalfW * 0.42, padHalfD * 0.38],
    ];
    for (const [ox, oz] of offsets) {
      const bw = padHalfW * 0.48;
      const bd = padHalfD * 0.4;
      const bh = 2.6 * s;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), ghostMat);
      mesh.position.set(ox, padHeight + bh * 0.5, oz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      kcnGroup.add(mesh);
    }
  }

  /* ==========================================================================
   * 7. PROCEDURAL 3D INDUSTRIAL FACILITY ARCHETYPES (`CLEAN_ROOM`, `SEMI_CLEAN_ROOM`, `NORMAL_ROOM`)
   * ========================================================================== */

  _buildCompanyFacilityOnPlot(kcnGroup, kcn, company, localPos, dims, padHeight, s) {
    const companyKey = company.company_key;
    const kcnCode = kcn.industrial_park_code;
    const [w, h, d] = dims;
    const archetype = company.buildingArchetype || 'SEMI_CLEAN_ROOM';

    const plotGroup = new THREE.Group();
    plotGroup.name = `COMPANY_${companyKey}`;
    plotGroup.position.set(localPos.x, padHeight, localPos.z);
    kcnGroup.add(plotGroup);

    const dimmableMaterials = [];
    const registerMat = (mat) => {
      mat.transparent = true;
      mat.userData = { ...(mat.userData || {}), baseOpacity: mat.opacity ?? 1.0 };
      dimmableMaterials.push(mat);
      return mat;
    };

    // 1. Concrete Plot Parcel Apron
    const apronW = w * 1.18;
    const apronD = d * 1.18;
    const apronH = 0.18 * s;
    const apronMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: PALETTE.day.plotPad.clone(),
        roughness: 0.78,
        metalness: 0.08,
      })
    );
    const apronMesh = new THREE.Mesh(new THREE.BoxGeometry(apronW, apronH, apronD), apronMat);
    apronMesh.position.set(0, apronH * 0.5, 0);
    apronMesh.receiveShadow = true;
    plotGroup.add(apronMesh);

    // 2. Facility Structural Group
    const facilityGroup = new THREE.Group();
    facilityGroup.position.y = apronH;
    plotGroup.add(facilityGroup);

    if (archetype === 'CLEAN_ROOM') {
      this._constructCleanRoomCampus(facilityGroup, w, h, d, s, registerMat);
    } else if (archetype === 'NORMAL_ROOM') {
      this._constructNormalManufacturingPlant(facilityGroup, w, h, d, s, registerMat);
    } else {
      this._constructSemiCleanAssemblyPlant(facilityGroup, w, h, d, s, registerMat);
    }

    let liveBeaconRing = null;
    if (company.job_count > 0) {
      const liveGeo = new THREE.RingGeometry(Math.min(w, d) * 0.18, Math.min(w, d) * 0.26, 28);
      liveGeo.rotateX(-Math.PI / 2);
      const liveMat = new THREE.MeshBasicMaterial({
        color: PALETTE.emeraldHighlight,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      liveBeaconRing = new THREE.Mesh(liveGeo, liveMat);
      liveBeaconRing.position.set(0, h + 0.45 * s, 0);
      facilityGroup.add(liveBeaconRing);
    }

    // 3. `Almukayman/Zone_D` Emerald Selection & Hover Wireframe Cage
    const outlineGroup = new THREE.Group();
    outlineGroup.position.y = apronH;
    plotGroup.add(outlineGroup);

    const cageW = w * 1.06;
    const cageH = h * 1.08;
    const cageD = d * 1.06;
    const cageBoxGeo = new THREE.BoxGeometry(cageW, cageH, cageD);
    const edgesGeo = new THREE.EdgesGeometry(cageBoxGeo);
    cageBoxGeo.dispose();

    const outlineLineMat = new THREE.LineBasicMaterial({
      color: PALETTE.emeraldHighlight,
      transparent: true,
      opacity: 0.0,
      depthTest: true,
    });
    const outlineWireframe = new THREE.LineSegments(edgesGeo, outlineLineMat);
    outlineWireframe.position.set(0, cageH * 0.5, 0);
    outlineGroup.add(outlineWireframe);

    const shellMat = new THREE.MeshBasicMaterial({
      color: PALETTE.emeraldHighlight,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const shellMesh = new THREE.Mesh(
      new THREE.BoxGeometry(cageW * 1.01, cageH * 1.01, cageD * 1.01),
      shellMat
    );
    shellMesh.position.set(0, cageH * 0.5, 0);
    outlineGroup.add(shellMesh);

    const apronRingPts = [
      new THREE.Vector3(-apronW * 0.52, 0.06 * s, -apronD * 0.52),
      new THREE.Vector3(apronW * 0.52, 0.06 * s, -apronD * 0.52),
      new THREE.Vector3(apronW * 0.52, 0.06 * s, apronD * 0.52),
      new THREE.Vector3(-apronW * 0.52, 0.06 * s, apronD * 0.52),
      new THREE.Vector3(-apronW * 0.52, 0.06 * s, -apronD * 0.52),
    ];
    const apronRingMat = new THREE.LineBasicMaterial({
      color: PALETTE.emeraldHighlight,
      transparent: true,
      opacity: 0.0,
    });
    const apronRingLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(apronRingPts),
      apronRingMat
    );
    outlineGroup.add(apronRingLine);

    // 4. Attach Raycast Pick Metadata
    const pickNode = {
      type: 'company',
      key: companyKey,
      kcnCode,
      companyKey,
      data: company,
    };
    facilityGroup.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.userData.pickNode = pickNode;
        this.pickableMeshes.push(child);
      }
    });
    apronMesh.userData.pickNode = pickNode;
    this.pickableMeshes.push(apronMesh);

    const worldPos = new THREE.Vector3(
      kcn.worldPosition[0] + localPos.x,
      (kcn.worldPosition[1] || 0) + padHeight + apronH,
      kcn.worldPosition[2] + localPos.z
    );
    const anchorWorldPos = new THREE.Vector3(
      worldPos.x,
      worldPos.y + h + 1.8 * s,
      worldPos.z
    );

    const record = {
      companyKey,
      kcnCode,
      data: company,
      plotGroup,
      facilityGroup,
      apronMat,
      worldPos,
      anchorWorldPos,
      dims: [w, h, d],
      dimmableMaterials,
      outlineLineMat,
      shellMat,
      apronRingMat,
      liveBeaconRing,
      highlightMix: 0,
      opacityMix: 1,
      targetOpacityMix: 1,
    };

    this.companyRecords.set(companyKey, record);
    return record;
  }

  _constructCleanRoomCampus(group, w, h, d, s, registerMat) {
    const silverShellMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0xf1f5f9,
        roughness: 0.3,
        metalness: 0.52,
      })
    );
    const glassCurtainMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0x0369a1,
        emissive: 0x0284c7,
        emissiveIntensity: 0.32,
        roughness: 0.14,
        metalness: 0.82,
      })
    );
    this.dynamicEmissiveMaterials.push({
      material: glassCurtainMat,
      dayIntensity: 0.22,
      nightIntensity: 0.95,
    });

    const cyanStripMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.95,
        roughness: 0.2,
      })
    );
    this.dynamicEmissiveMaterials.push({
      material: cyanStripMat,
      dayIntensity: 0.65,
      nightIntensity: 1.85,
    });

    const hvacMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.5,
        metalness: 0.45,
      })
    );

    const fabW = w * 0.66;
    const fabH = h * 0.92;
    const fabD = d * 0.88;
    const fabMesh = new THREE.Mesh(new THREE.BoxGeometry(fabW, fabH, fabD), silverShellMat);
    fabMesh.position.set(-w * 0.14, fabH * 0.5, -d * 0.04);
    group.add(fabMesh);

    const towerW = w * 0.36;
    const towerH = h * 1.12;
    const towerD = d * 0.76;
    const towerMesh = new THREE.Mesh(
      new THREE.BoxGeometry(towerW, towerH, towerD),
      glassCurtainMat
    );
    towerMesh.position.set(w * 0.3, towerH * 0.5, d * 0.08);
    group.add(towerMesh);

    const bridgeMesh = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.22, h * 0.22, d * 0.24),
      glassCurtainMat
    );
    bridgeMesh.position.set(w * 0.08, h * 0.58, d * 0.04);
    group.add(bridgeMesh);

    const fabCrown = new THREE.Mesh(
      new THREE.BoxGeometry(fabW * 1.02, h * 0.055, fabD * 1.02),
      cyanStripMat
    );
    fabCrown.position.set(-w * 0.14, fabH - h * 0.03, -d * 0.04);
    group.add(fabCrown);

    const towerCrown = new THREE.Mesh(
      new THREE.BoxGeometry(towerW * 1.03, h * 0.055, towerD * 1.03),
      cyanStripMat
    );
    towerCrown.position.set(w * 0.3, towerH - h * 0.03, d * 0.08);
    group.add(towerCrown);

    const chillerW = fabW * 0.22;
    const chillerH = h * 0.18;
    const chillerD = fabD * 0.26;
    for (let i = -1; i <= 1; i++) {
      const chiller = new THREE.Mesh(
        new THREE.BoxGeometry(chillerW, chillerH, chillerD),
        hvacMat
      );
      chiller.position.set(-w * 0.14 + i * (fabW * 0.28), fabH + chillerH * 0.5, -d * 0.12);
      group.add(chiller);
    }
  }

  _constructSemiCleanAssemblyPlant(group, w, h, d, s, registerMat) {
    const whiteCladdingMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        roughness: 0.48,
        metalness: 0.18,
      })
    );
    const cobaltAccentMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: this.activeSkinTokens.primary,
        roughness: 0.38,
        metalness: 0.32,
      })
    );
    this.skinAccentMaterials.push({ material: cobaltAccentMat, role: 'primary' });

    const solarPanelMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e3a8a,
        emissive: 0x172554,
        emissiveIntensity: 0.25,
        roughness: 0.22,
        metalness: 0.72,
      })
    );
    const windowStripMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0xfef3c7,
        emissive: PALETTE.warmWindow,
        emissiveIntensity: 0.5,
        roughness: 0.25,
      })
    );
    this.dynamicEmissiveMaterials.push({
      material: windowStripMat,
      dayIntensity: 0.28,
      nightIntensity: 1.35,
    });

    const bayW = w * 0.46;
    const bayH = h * 0.88;
    const bayD = d * 0.84;

    const leftBay = new THREE.Mesh(new THREE.BoxGeometry(bayW, bayH, bayD), whiteCladdingMat);
    leftBay.position.set(-w * 0.24, bayH * 0.5, -d * 0.04);
    const rightBay = new THREE.Mesh(new THREE.BoxGeometry(bayW, bayH, bayD), whiteCladdingMat);
    rightBay.position.set(w * 0.24, bayH * 0.5, -d * 0.04);
    group.add(leftBay, rightBay);

    const spineMesh = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.14, bayH * 0.96, bayD * 0.92),
      cobaltAccentMat
    );
    spineMesh.position.set(0, bayH * 0.48, -d * 0.04);
    group.add(spineMesh);

    const facadeCornice = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.98, h * 0.14, d * 0.88),
      cobaltAccentMat
    );
    facadeCornice.position.set(0, bayH - h * 0.06, -d * 0.04);
    group.add(facadeCornice);

    const windowRibbon = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.99, h * 0.15, d * 0.86),
      windowStripMat
    );
    windowRibbon.position.set(0, bayH * 0.52, -d * 0.04);
    group.add(windowRibbon);

    const solarGeo = new THREE.BoxGeometry(bayW * 0.82, h * 0.04, bayD * 0.34);
    for (const bx of [-w * 0.24, w * 0.24]) {
      for (const bz of [-bayD * 0.22, bayD * 0.18]) {
        const solar = new THREE.Mesh(solarGeo, solarPanelMat);
        solar.position.set(bx, bayH + h * 0.03, bz);
        solar.rotation.x = 0.08;
        group.add(solar);
      }
    }

    const atriumMesh = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.38, h * 0.56, d * 0.22),
      cobaltAccentMat
    );
    atriumMesh.position.set(-w * 0.24, h * 0.28, d * 0.42);
    group.add(atriumMesh);
  }

  _constructNormalManufacturingPlant(group, w, h, d, s, registerMat) {
    const heavyWallMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.65,
        metalness: 0.22,
      })
    );
    const roofMetalMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0x64748b,
        roughness: 0.54,
        metalness: 0.45,
      })
    );
    const warmWindowMat = registerMat(
      new THREE.MeshStandardMaterial({
        color: 0xfde68a,
        emissive: PALETTE.amberGlow,
        emissiveIntensity: 0.65,
        roughness: 0.25,
      })
    );
    this.dynamicEmissiveMaterials.push({
      material: warmWindowMat,
      dayIntensity: 0.32,
      nightIntensity: 1.55,
    });

    const hallW = w * 0.78;
    const hallH = h * 0.78;
    const hallD = d * 0.86;
    const hallMesh = new THREE.Mesh(new THREE.BoxGeometry(hallW, hallH, hallD), heavyWallMat);
    hallMesh.position.set(-w * 0.08, hallH * 0.5, 0);
    group.add(hallMesh);

    const windowBand = new THREE.Mesh(
      new THREE.BoxGeometry(hallW * 1.01, hallH * 0.2, hallD * 1.01),
      warmWindowMat
    );
    windowBand.position.set(-w * 0.08, hallH * 0.62, 0);
    group.add(windowBand);

    const ridgeCount = 3;
    const ridgeD = hallD / ridgeCount;
    const ridgeH = h * 0.24;
    for (let i = 0; i < ridgeCount; i++) {
      const rz = -hallD * 0.5 + ridgeD * (i + 0.5);
      const ridgeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(hallW * 0.96, ridgeH, ridgeD * 0.82),
        roofMetalMat
      );
      ridgeMesh.position.set(-w * 0.08, hallH + ridgeH * 0.42, rz);
      ridgeMesh.rotation.x = 0.22;
      group.add(ridgeMesh);
    }

    const siloRadius = Math.min(w, d) * 0.09;
    const siloH = h * 0.95;
    const siloGeo = new THREE.CylinderGeometry(siloRadius, siloRadius, siloH, 16);
    for (const sz of [-d * 0.22, d * 0.06]) {
      const silo = new THREE.Mesh(siloGeo, roofMetalMat);
      silo.position.set(w * 0.38, siloH * 0.5, sz);
      group.add(silo);
    }

    const stackGeo = new THREE.CylinderGeometry(siloRadius * 0.35, siloRadius * 0.48, h * 1.28, 12);
    const stackMesh = new THREE.Mesh(stackGeo, roofMetalMat);
    stackMesh.position.set(-w * 0.28, h * 0.64, -d * 0.26);
    group.add(stackMesh);
  }

  /* ==========================================================================
   * 8. DAY / NIGHT ATMOSPHERIC LIGHTING (`setDayNightMode(isNight)`)
   * ========================================================================== */

  setDayNightMode(isNight) {
    if (typeof isNight === 'string') {
      this.isNight = isNight.toLowerCase() === 'night' || isNight.toLowerCase() === 'dark';
    } else {
      this.isNight = Boolean(isNight);
    }
    this.targetDayNightMix = this.isNight ? 1 : 0;
    return this.isNight;
  }

  toggleDayNightMode() {
    return this.setDayNightMode(!this.isNight);
  }

  getDayNightMode() {
    return this.isNight;
  }

  _applyAtmosphereUniforms(mix) {
    const t = Math.max(0, Math.min(1, mix));

    // Sky background & fog
    this.scene.background.lerpColors(PALETTE.day.skyBg, PALETTE.night.skyBg, t);
    this.scene.fog.color.lerpColors(PALETTE.day.fogColor, PALETTE.night.fogColor, t);

    // Directional Sun/Moon & Hemisphere Lights
    this.hemiLight.color.lerpColors(PALETTE.day.hemiSky, PALETTE.night.hemiSky, t);
    this.hemiLight.groundColor.lerpColors(PALETTE.day.hemiGround, PALETTE.night.hemiGround, t);
    this.hemiLight.intensity = THREE.MathUtils.lerp(
      PALETTE.day.hemiIntensity,
      PALETTE.night.hemiIntensity,
      t
    );

    this.sunLight.color.lerpColors(PALETTE.day.sunColor, PALETTE.night.sunColor, t);
    this.sunLight.intensity = THREE.MathUtils.lerp(
      PALETTE.day.sunIntensity,
      PALETTE.night.sunIntensity,
      t
    );

    this.rimLight.color.lerpColors(PALETTE.day.rimColor, PALETTE.night.rimColor, t);
    this.rimLight.intensity = THREE.MathUtils.lerp(
      PALETTE.day.rimIntensity,
      PALETTE.night.rimIntensity,
      t
    );

    // Terrain & Water materials
    const tm = this.terrainMaterials;
    if (tm.baseMat) {
      tm.baseMat.color.lerpColors(PALETTE.day.tableBase, PALETTE.night.tableBase, t);
      tm.topMat.color.lerpColors(PALETTE.day.tableTop, PALETTE.night.tableTop, t);
      tm.plateauTopMat.color.lerpColors(PALETTE.day.plateauTop, PALETTE.night.plateauTop, t);
      tm.plateauSideMat.color.lerpColors(PALETTE.day.plateauSide, PALETTE.night.plateauSide, t);
      tm.waterMat.color.lerpColors(PALETTE.day.waterColor, PALETTE.night.waterColor, t);
      tm.waterMat.emissive.lerpColors(PALETTE.day.waterEmissive, PALETTE.night.waterEmissive, t);
      tm.waterMat.emissiveIntensity = THREE.MathUtils.lerp(0.18, 0.72, t);
    }

    // Macro map tile tint (crisp white in day, gently dimmed at night so beacons & windows glow)
    const dayTileTint = new THREE.Color(0xffffff);
    const nightTileTint = new THREE.Color(0x475569);
    for (const rec of this.macroTileMeshes) {
      rec.material.color.lerpColors(dayTileTint, nightTileTint, t);
    }

    // KCN Pads & KCN High-Zoom Map Canvases
    for (const [, kcnRec] of this.kcnRecords) {
      kcnRec.padMat.color.lerpColors(PALETTE.day.kcnPadBase, PALETTE.night.kcnPadBase, t);
      if (kcnRec.mapPadState?.material) {
        kcnRec.mapPadState.material.color.lerpColors(dayTileTint, nightTileTint, t);
      }
    }

    // Plot Parcel Aprons
    for (const [, compRec] of this.companyRecords) {
      if (compRec.apronMat) {
        compRec.apronMat.color.lerpColors(PALETTE.day.plotPad, PALETTE.night.plotPad, t);
      }
    }

    // Emissive Factory Windows, Cleanroom Cyan Strips & Expressway Splines
    for (const item of this.dynamicEmissiveMaterials) {
      item.material.emissiveIntensity = THREE.MathUtils.lerp(
        item.dayIntensity,
        item.nightIntensity,
        t
      );
    }

    // Vehicle Headlights & Taillights brighten at night
    if (this.vehicleShared) {
      this.vehicleShared.headlightMat.emissiveIntensity = THREE.MathUtils.lerp(1.25, 2.8, t);
      this.vehicleShared.taillightMat.emissiveIntensity = THREE.MathUtils.lerp(1.2, 2.4, t);
    }

    // Streetlamps
    for (const mat of this.streetLampMaterials) {
      mat.emissiveIntensity = THREE.MathUtils.lerp(0.15, 2.2, t);
    }
  }

  /* ==========================================================================
   * 9. CUBIC-BEZIER CAMERA SPLINE FLIGHT & 4-SIDE ORBIT (`THREE.CubicBezierCurve3`)
   * ========================================================================== */

  flyToLevel1(options = {}) {
    let provinceCode = null;
    let immediate = false;
    if (typeof options === 'string') {
      provinceCode = options;
    } else if (options && typeof options === 'object') {
      provinceCode = options.provinceCode ?? options.province_code ?? null;
      immediate = Boolean(options.immediate);
    }
    if (provinceCode === 'ALL' || provinceCode === '') provinceCode = null;

    this.currentLevel = 1;
    this.activeProvinceCode = provinceCode;
    this.activeKcnCode = null;
    this.activeCompanyKey = null;
    this._updateDimmingState();

    const pose = this._computeLevel1CameraPose(provinceCode);
    this._launchBezierFlight(pose.position, pose.target, immediate ? 0 : 1100);
  }

  flyToLevel2(industrialParkCode, { immediate = false } = {}) {
    const code =
      typeof industrialParkCode === 'object'
        ? industrialParkCode?.industrial_park_code || industrialParkCode?.kcnCode
        : industrialParkCode;
    const kcnRec = this.kcnRecords.get(code);
    if (!kcnRec) return false;

    this.currentLevel = 2;
    this.activeKcnCode = code;
    this.activeProvinceCode = kcnRec.data.province_code || this.activeProvinceCode;
    this.activeCompanyKey = null;
    this._updateDimmingState();

    // Ensure high-zoom (zoom=15) real map tiles are loaded onto this KCN's polygon pad
    this._loadKcnHighZoomMapCanvas(kcnRec, this.mapStyle);

    const pose = this._computeLevel2CameraPose(kcnRec);
    this._launchBezierFlight(pose.position, pose.target, immediate ? 0 : 1150);
    return true;
  }

  flyToLevel3(companyKey, side = 'south', { immediate = false } = {}) {
    let resolvedKey = companyKey;
    let resolvedSide = side;
    if (companyKey && typeof companyKey === 'object') {
      resolvedKey = companyKey.company_key || companyKey.companyKey || companyKey.key;
      resolvedSide = companyKey.side || side;
    }

    const compRec = this.companyRecords.get(resolvedKey);
    if (!compRec) return false;

    this.currentLevel = 3;
    this.activeCompanyKey = resolvedKey;
    this.activeKcnCode = compRec.kcnCode;
    this.activeSide = normalizeSide(resolvedSide);
    this._updateDimmingState();

    const kcnRec = this.kcnRecords.get(compRec.kcnCode);
    if (kcnRec) {
      this._loadKcnHighZoomMapCanvas(kcnRec, this.mapStyle);
    }

    const pose = this._computeLevel3CameraPose(compRec, this.activeSide);
    this._launchBezierFlight(pose.position, pose.target, immediate ? 0 : 850);
    return true;
  }

  orbitCompanySide(side = 'south') {
    const normalized = normalizeSide(side);
    this.activeSide = normalized;

    if (this.currentLevel === 3 && this.activeCompanyKey) {
      const compRec = this.companyRecords.get(this.activeCompanyKey);
      if (!compRec) return false;
      const pose = this._computeLevel3CameraPose(compRec, normalized);
      this._launchBezierFlight(pose.position, pose.target, 780, {
        isCircularOrbit: true,
        pivot: pose.target,
      });
      return true;
    }

    if (this.currentLevel === 2 && this.activeKcnCode) {
      const kcnRec = this.kcnRecords.get(this.activeKcnCode);
      if (!kcnRec) return false;
      const pose = this._computeLevel2CameraPose(kcnRec, normalized);
      this._launchBezierFlight(pose.position, pose.target, 780, {
        isCircularOrbit: true,
        pivot: pose.target,
      });
      return true;
    }

    return false;
  }

  selectKcn(kcnCode) {
    return this.flyToLevel2(kcnCode);
  }

  selectCompany(companyKey, side = 'south') {
    return this.flyToLevel3(companyKey, side);
  }

  selectProvince(provinceCode) {
    return this.flyToLevel1({ provinceCode });
  }

  resetView() {
    return this.flyToLevel1({ provinceCode: null });
  }

  set2DMode(enabled) {
    this.is2DMode = Boolean(enabled);
  }

  setViewMode(mode) {
    this.is2DMode = String(mode).toLowerCase().includes('2d');
  }

  getState() {
    return {
      level: this.currentLevel,
      activeProvinceCode: this.activeProvinceCode,
      activeKcnCode: this.activeKcnCode,
      activeCompanyKey: this.activeCompanyKey,
      activeSide: this.activeSide,
      isNight: this.isNight,
      skinId: this.activeSkinId,
      mapStyle: this.mapStyle,
      isTransitioning: this.flightState.active,
    };
  }

  _computeLevel1CameraPose(provinceCode = null) {
    const { center, span } = this.worldBounds;

    if (provinceCode && this.provincesByCode.has(provinceCode)) {
      const prov = this.provincesByCode.get(provinceCode);
      if (prov.cameraOverviewPose?.position && prov.cameraOverviewPose?.target) {
        return {
          position: toVec3(prov.cameraOverviewPose.position),
          target: toVec3(prov.cameraOverviewPose.target),
        };
      }

      const provKcns = Array.from(this.kcnRecords.values()).filter(
        (r) => r.data.province_code === provinceCode
      );
      if (provKcns.length > 0) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const r of provKcns) {
          if (r.worldPos.x < minX) minX = r.worldPos.x;
          if (r.worldPos.x > maxX) maxX = r.worldPos.x;
          if (r.worldPos.z < minZ) minZ = r.worldPos.z;
          if (r.worldPos.z > maxZ) maxZ = r.worldPos.z;
        }
        const pSpan = Math.max(maxX - minX, maxZ - minZ, span * 0.36);
        const target = new THREE.Vector3((minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5);
        const position = new THREE.Vector3(
          target.x + pSpan * 0.14,
          pSpan * 0.78,
          target.z + pSpan * 0.96
        );
        return { position, target };
      }
    }

    const target = new THREE.Vector3(center.x - span * 0.03, 0, center.z + span * 0.02);
    const position = new THREE.Vector3(
      center.x + span * 0.08,
      span * 0.62,
      center.z + span * 0.82
    );
    return { position, target };
  }

  _computeLevel2CameraPose(kcnRec, side = 'south') {
    const dir = SIDE_VECTORS[normalizeSide(side)] || SIDE_VECTORS.south;
    const compoundRadius = Math.max(kcnRec.padHalfW, kcnRec.padHalfD, 16);

    const horizDist = compoundRadius * 2.05;
    const altitude = horizDist * Math.tan((38 * Math.PI) / 180);

    if (side === 'south' && kcnRec.data.cameraZonePose?.position) {
      const adapterPos = toVec3(kcnRec.data.cameraZonePose.position);
      const adapterTarget = toVec3(
        kcnRec.data.cameraZonePose.target,
        [kcnRec.worldPos.x, kcnRec.padHeight, kcnRec.worldPos.z]
      );
      const offset = adapterPos.clone().sub(adapterTarget);
      const minRequiredDist = compoundRadius * 2.15;
      if (offset.length() < minRequiredDist && offset.length() > 0.1) {
        offset.setLength(minRequiredDist);
      }
      return {
        position: adapterTarget.clone().add(offset),
        target: adapterTarget,
      };
    }

    const target = new THREE.Vector3(
      kcnRec.worldPos.x,
      kcnRec.worldPos.y + kcnRec.padHeight + 1.2,
      kcnRec.worldPos.z
    );
    const position = new THREE.Vector3(
      target.x + dir.x * horizDist,
      target.y + altitude,
      target.z + dir.z * horizDist
    );
    return { position, target };
  }

  _computeLevel3CameraPose(compRec, side = 'south') {
    const normSide = normalizeSide(side);
    const [w, h, d] = compRec.dims;
    const target = new THREE.Vector3(
      compRec.worldPos.x,
      compRec.worldPos.y + h * 0.42,
      compRec.worldPos.z
    );

    const rawOrbitPose = compRec.data?.orbitPoses?.[normSide];
    if (rawOrbitPose) {
      const pos = rawOrbitPose.position
        ? toVec3(rawOrbitPose.position)
        : toVec3(rawOrbitPose);
      const tgt = rawOrbitPose.target ? toVec3(rawOrbitPose.target) : target;
      const offset = pos.clone().sub(tgt);
      const minSafeDist = Math.max(w, d) * 1.9;
      if (offset.length() < minSafeDist && offset.length() > 0.1) {
        offset.setLength(minSafeDist);
      }
      return {
        position: tgt.clone().add(offset),
        target: tgt,
      };
    }

    const dir = SIDE_VECTORS[normSide] || SIDE_VECTORS.south;
    const facilitySpan = Math.max(w, d, 12);
    const distance = Math.max(facilitySpan * 2.55, 28);
    const altitude = Math.max(distance * 0.62, h * 2.1, 18);

    const position = new THREE.Vector3(
      target.x + dir.x * distance,
      target.y + altitude,
      target.z + dir.z * distance
    );
    return { position, target };
  }

  _launchBezierFlight(endPos, endTarget, durationMs = 1000, options = {}) {
    if (durationMs <= 0) {
      this.flightState.active = false;
      this.camera.position.copy(endPos);
      this.cameraTarget.copy(endTarget);
      this.camera.lookAt(this.cameraTarget);
      this._syncSphericalFromCamera();
      this._emitTransitionState(false);
      return;
    }

    const startPos = this.camera.position.clone();
    const startTarget = this.cameraTarget.clone();

    let c1;
    let c2;

    if (options.isCircularOrbit && options.pivot) {
      const pivot = options.pivot;
      const vStart = startPos.clone().sub(pivot);
      const vEnd = endPos.clone().sub(pivot);
      const rStart = Math.hypot(vStart.x, vStart.z);
      const rEnd = Math.hypot(vEnd.x, vEnd.z);
      const rMid = Math.max(rStart, rEnd) * 1.08;

      const angleStart = Math.atan2(vStart.x, vStart.z);
      let angleEnd = Math.atan2(vEnd.x, vEnd.z);
      let delta = angleEnd - angleStart;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      const a1 = angleStart + delta * 0.33;
      const a2 = angleStart + delta * 0.67;

      c1 = new THREE.Vector3(
        pivot.x + Math.sin(a1) * rMid,
        THREE.MathUtils.lerp(startPos.y, endPos.y, 0.35) + 2.5,
        pivot.z + Math.cos(a1) * rMid
      );
      c2 = new THREE.Vector3(
        pivot.x + Math.sin(a2) * rMid,
        THREE.MathUtils.lerp(startPos.y, endPos.y, 0.7) + 1.8,
        pivot.z + Math.cos(a2) * rMid
      );
    } else {
      const dist = startPos.distanceTo(endPos);
      const arcLift = Math.min(Math.max(dist * 0.22, 8), 75);
      const maxAlt = Math.max(startPos.y, endPos.y);

      c1 = startPos.clone().lerp(endPos, 0.32);
      c1.y = THREE.MathUtils.lerp(startPos.y, maxAlt, 0.65) + arcLift * 0.65;

      c2 = startPos.clone().lerp(endPos, 0.68);
      c2.y = THREE.MathUtils.lerp(maxAlt, endPos.y, 0.55) + arcLift * 0.35;
    }

    const tc1 = startTarget.clone().lerp(endTarget, 0.33);
    const tc2 = startTarget.clone().lerp(endTarget, 0.67);

    this.flightState = {
      active: true,
      startTime: performance.now(),
      duration: durationMs,
      posCurve: new THREE.CubicBezierCurve3(startPos, c1, c2, endPos.clone()),
      targetCurve: new THREE.CubicBezierCurve3(startTarget, tc1, tc2, endTarget.clone()),
    };

    this._emitTransitionState(true);
  }

  _emitTransitionState(isTransitioning) {
    if (typeof this.onTransitionStateChange === 'function') {
      this.onTransitionStateChange({
        isTransitioning,
        level: this.currentLevel,
        activeProvinceCode: this.activeProvinceCode,
        activeKcnCode: this.activeKcnCode,
        activeCompanyKey: this.activeCompanyKey,
        activeSide: this.activeSide,
      });
    }
  }

  /* ==========================================================================
   * 10. BIDIRECTIONAL <150ms HOVER SYNC & LEVEL 3 NEIGHBOR DIMMING (`dimOthers`)
   * ========================================================================== */

  highlightNode(payload, secondArg = null) {
    if (!payload) {
      this.externalHoveredNode = null;
      this._resolveEffectiveHover();
      return;
    }

    if (typeof payload === 'string') {
      if (secondArg) {
        this.externalHoveredNode = { type: payload, key: String(secondArg) };
      } else if (this.kcnsByCode.has(payload)) {
        this.externalHoveredNode = { type: 'kcn', key: payload };
      } else {
        this.externalHoveredNode = { type: 'company', key: payload };
      }
      this._resolveEffectiveHover();
      return;
    }

    const key =
      payload.key ||
      payload.id ||
      payload.companyKey ||
      payload.company_key ||
      payload.kcnCode ||
      payload.industrial_park_code ||
      null;
    if (!key) {
      this.externalHoveredNode = null;
      this._resolveEffectiveHover();
      return;
    }

    const type = payload.type || (this.kcnsByCode.has(key) ? 'kcn' : 'company');
    this.externalHoveredNode = { type, key };
    this._resolveEffectiveHover();
  }

  _resolveEffectiveHover() {
    const active = this.pointerHoveredNode || this.externalHoveredNode;
    this.effectiveHoveredKey = active ? active.key : null;
    this.effectiveHoveredType = active ? active.type : null;
  }

  _updateDimmingState() {
    const isLevel3 = this.currentLevel === 3 && Boolean(this.activeCompanyKey);
    for (const [compKey, rec] of this.companyRecords) {
      if (!isLevel3) {
        rec.targetOpacityMix = 1.0;
      } else if (compKey === this.activeCompanyKey) {
        rec.targetOpacityMix = 1.0;
      } else if (rec.kcnCode === this.activeKcnCode) {
        rec.targetOpacityMix = 0.28;
      } else {
        rec.targetOpacityMix = 0.45;
      }
    }
  }

  /* ==========================================================================
   * 11. POINTER / TOUCH ORBIT, WHEEL ZOOM & 3D RAYCAST PICKING
   * ========================================================================== */

  _syncSphericalFromCamera() {
    const offset = this.camera.position.clone().sub(this.cameraTarget);
    this.spherical.setFromVector3(offset);
    this.targetSpherical.copy(this.spherical);
    this.panOffset.set(0, 0, 0);
    this.targetPanOffset.set(0, 0, 0);
  }

  _bindEvents() {
    this._onPointerDown = (e) => {
      this.pointerState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointerState.activePointers.size === 2) {
        const pts = Array.from(this.pointerState.activePointers.values());
        this.pointerState.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        return;
      }

      this.pointerState.isDown = true;
      this.pointerState.button = e.button;
      this.pointerState.startX = e.clientX;
      this.pointerState.startY = e.clientY;
      this.pointerState.lastX = e.clientX;
      this.pointerState.lastY = e.clientY;
      this.pointerState.movedDistance = 0;
    };

    this._onPointerMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.pointerClient.x = e.clientX;
        this.pointerClient.y = e.clientY;
        this.needsRaycast = true;
      }

      if (this.pointerState.activePointers.has(e.pointerId)) {
        this.pointerState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this.pointerState.activePointers.size === 2) {
        const pts = Array.from(this.pointerState.activePointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pointerState.lastPinchDist > 0) {
          const factor = this.pointerState.lastPinchDist / Math.max(dist, 10);
          this.targetSpherical.radius = THREE.MathUtils.clamp(
            this.targetSpherical.radius * factor,
            14,
            this.worldBounds.span * 2.2
          );
        }
        this.pointerState.lastPinchDist = dist;
        return;
      }

      if (!this.pointerState.isDown || this.flightState.active) return;

      const dx = e.clientX - this.pointerState.lastX;
      const dy = e.clientY - this.pointerState.lastY;
      this.pointerState.lastX = e.clientX;
      this.pointerState.lastY = e.clientY;
      this.pointerState.movedDistance += Math.hypot(dx, dy);

      const rotateSpeed = 0.0052;
      this.targetSpherical.theta -= dx * rotateSpeed;
      this.targetSpherical.phi = THREE.MathUtils.clamp(
        this.targetSpherical.phi - dy * rotateSpeed,
        0.18,
        Math.PI * 0.44
      );
    };

    this._onPointerUp = (e) => {
      this.pointerState.activePointers.delete(e.pointerId);
      const wasClick =
        this.pointerState.isDown &&
        this.pointerState.button === 0 &&
        this.pointerState.movedDistance < 6;
      this.pointerState.isDown = false;

      if (wasClick && !this.is2DMode) {
        this._handleSceneClick();
      }
    };

    this._onWheel = (e) => {
      if (this.flightState.active) return;
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
      const minRadius = this.currentLevel === 3 ? 15 : this.currentLevel === 2 ? 24 : 45;
      const maxRadius = this.worldBounds.span * 2.2;
      this.targetSpherical.radius = THREE.MathUtils.clamp(
        this.targetSpherical.radius * zoomFactor,
        minRadius,
        maxRadius
      );
    };

    this._onPointerLeave = () => {
      this.pointerState.isDown = false;
      this.pointerState.activePointers.clear();
      if (this.pointerHoveredNode) {
        this.pointerHoveredNode = null;
        this._resolveEffectiveHover();
        this.canvas.style.cursor = 'grab';
        if (typeof this.onHoverNode === 'function') {
          this.onHoverNode(null);
        }
      }
    };

    this._onResize = () => this.resize();

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('resize', this._onResize);
  }

  _performRaycastHover() {
    if (!this.needsRaycast || this.pointerState.isDown || this.is2DMode) return;
    this.needsRaycast = false;

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickableMeshes, false);

    let nextHover = null;
    if (hits.length > 0) {
      const pick = hits[0].object?.userData?.pickNode;
      if (pick) {
        if (this.currentLevel === 1) {
          const kcnData = this.kcnsByCode.get(pick.kcnCode);
          nextHover = {
            type: 'kcn',
            key: pick.kcnCode,
            kcnCode: pick.kcnCode,
            data: kcnData || pick.data,
          };
        } else if (pick.type === 'company') {
          nextHover = {
            type: 'company',
            key: pick.companyKey,
            kcnCode: pick.kcnCode,
            companyKey: pick.companyKey,
            data: pick.data,
          };
        } else if (pick.type === 'kcn') {
          nextHover = {
            type: 'kcn',
            key: pick.kcnCode,
            kcnCode: pick.kcnCode,
            data: pick.data,
          };
        }
      }
    }

    const prevKey = this.pointerHoveredNode?.key || null;
    const prevType = this.pointerHoveredNode?.type || null;
    const nextKey = nextHover?.key || null;
    const nextType = nextHover?.type || null;

    if (prevKey !== nextKey || prevType !== nextType) {
      this.pointerHoveredNode = nextHover;
      this._resolveEffectiveHover();
      this.canvas.style.cursor = nextHover ? 'pointer' : 'grab';
      if (typeof this.onHoverNode === 'function') {
        this.onHoverNode(nextHover);
      }
    }
  }

  _handleSceneClick() {
    this.needsRaycast = true;
    this._performRaycastHover();

    const target = this.pointerHoveredNode;
    if (!target) return;

    if (this.currentLevel === 1) {
      const kcnCode = target.kcnCode || target.key;
      const kcnData = this.kcnsByCode.get(kcnCode);
      this.flyToLevel2(kcnCode);
      if (typeof this.onSelectKcn === 'function') {
        this.onSelectKcn(kcnCode, kcnData);
      }
      return;
    }

    if (target.type === 'company' && target.companyKey) {
      const compData = this.companiesByKey.get(target.companyKey);
      this.flyToLevel3(target.companyKey, 'south');
      if (typeof this.onSelectCompany === 'function') {
        this.onSelectCompany(target.companyKey, compData);
      }
      return;
    }

    if (target.type === 'kcn' && target.kcnCode && target.kcnCode !== this.activeKcnCode) {
      const kcnData = this.kcnsByCode.get(target.kcnCode);
      this.flyToLevel2(target.kcnCode);
      if (typeof this.onSelectKcn === 'function') {
        this.onSelectKcn(target.kcnCode, kcnData);
      }
    }
  }

  /* ==========================================================================
   * 12. ANIMATION LOOP, 3D VEHICLE MOTION, <150ms HIGHLIGHT LERP & PROJECTION
   * ========================================================================== */

  _startLoop() {
    const tick = () => {
      if (this.isDisposed) return;
      this.frame = requestAnimationFrame(tick);
      if (this.renderPaused || document.hidden) return;

      const dt = Math.min(this.clock.getDelta(), 0.1);
      this.elapsedTime += dt;

      this._updateDayNightTransition(dt);
      this._updateCameraController(dt);
      const width = this.canvas.clientWidth || window.innerWidth || 1280;
      const height = this.canvas.clientHeight || window.innerHeight || 720;
      this._syncCameraViewOffset(width, height, false, dt);
      this._performRaycastHover();
      this._updateSceneAnimations(dt);
      this.renderer.render(this.scene, this.camera);
      this._projectScreenAnchorsAndCompass();
    };
    this.frame = requestAnimationFrame(tick);
  }

  _updateDayNightTransition(dt) {
    if (Math.abs(this.dayNightMix - this.targetDayNightMix) > 0.001) {
      const speed = dt * 2.2;
      if (this.dayNightMix < this.targetDayNightMix) {
        this.dayNightMix = Math.min(this.targetDayNightMix, this.dayNightMix + speed);
      } else {
        this.dayNightMix = Math.max(this.targetDayNightMix, this.dayNightMix - speed);
      }
      this._applyAtmosphereUniforms(this.dayNightMix);
    }
  }

  _updateCameraController(dt) {
    if (this.flightState.active) {
      const now = performance.now();
      const rawT = (now - this.flightState.startTime) / Math.max(this.flightState.duration, 1);
      const clampedT = Math.max(0, Math.min(1, rawT));
      const easedT = easeInOutCubic(clampedT);

      const pos = this.flightState.posCurve.getPoint(easedT);
      const tgt = this.flightState.targetCurve.getPoint(easedT);

      this.camera.position.copy(pos);
      this.cameraTarget.copy(tgt);
      this.camera.lookAt(this.cameraTarget);

      if (clampedT >= 1) {
        this.flightState.active = false;
        this._syncSphericalFromCamera();
        this._emitTransitionState(false);
      }
      return;
    }

    const damp = 1 - Math.exp(-dt * 14);
    this.spherical.radius = THREE.MathUtils.lerp(
      this.spherical.radius,
      this.targetSpherical.radius,
      damp
    );
    this.spherical.theta = THREE.MathUtils.lerp(
      this.spherical.theta,
      this.targetSpherical.theta,
      damp
    );
    this.spherical.phi = THREE.MathUtils.lerp(
      this.spherical.phi,
      this.targetSpherical.phi,
      damp
    );

    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.cameraTarget).add(offset);
    this.camera.lookAt(this.cameraTarget);
  }

  _updateTraffic(dt) {
    // 3D Miniature Cars, Worker Shuttle Buses & Motorbikes driving in two-way right-hand lanes
    // Uses local parent-space rotation (`Math.atan2(dx, dz)`) instead of world-space `lookAt`
    // so vehicles inside translated KCN groups always drive 100% straight along their lane!
    for (const v of this.trafficVehicles) {
      v.t = (v.t + v.speed * dt + 1) % 1;
      const pt = v.curve.getPointAt(v.t);
      const tangent = v.curve.getTangentAt(v.t);

      // Forward movement vector along direction of travel (flips when speed < 0)
      const dirSign = v.speed >= 0 ? 1 : -1;
      const dx = tangent.x * dirSign;
      const dz = tangent.z * dirSign;

      // Right-hand side perpendicular vector in XZ plane: forward × up = (-dz, 0, dx)
      const rightX = -dz;
      const rightZ = dx;
      const bob = Math.sin(this.elapsedTime * 11 + v.bobPhase) * 0.004;

      v.mesh.position.set(
        pt.x + rightX * v.laneRightOffset,
        pt.y + v.heightOffset + bob,
        pt.z + rightZ * v.laneRightOffset
      );
      v.mesh.rotation.set(0, Math.atan2(dx, dz), 0);
    }
  }

  _updateSceneAnimations(dt) {
    // 1. Update 3D Vehicle Traffic
    this._updateTraffic(dt);

    const fastHighlightLerp = 1 - Math.exp(-dt * 24);
    const dimLerp = 1 - Math.exp(-dt * 12);

    // 2. KCN Hover Border Glow
    const hoverAccentHex = this.activeSkinTokens.hoverAccent || PALETTE.cyanHover;

    for (const [kcnCode, rec] of this.kcnRecords) {
      const isHovered =
        (this.effectiveHoveredType === 'kcn' && this.effectiveHoveredKey === kcnCode) ||
        (this.currentLevel === 2 && this.activeKcnCode === kcnCode);

      const targetHover = isHovered ? 1 : 0;
      rec.hoverMix = THREE.MathUtils.lerp(rec.hoverMix, targetHover, fastHighlightLerp);

      rec.borderMat.color.setHex(
        rec.hoverMix > 0.45 ? hoverAccentHex : rec.baseBorderColor
      );
      rec.borderMat.emissive.setHex(
        rec.hoverMix > 0.45 ? hoverAccentHex : rec.baseBorderColor
      );
      rec.borderMat.emissiveIntensity = THREE.MathUtils.lerp(
        rec.isActive ? 0.85 : 0.25,
        1.75,
        rec.hoverMix
      );
    }

    // 3. Company Building Emerald Wireframe Outline & Level 3 Neighbor Dimming
    for (const [compKey, rec] of this.companyRecords) {
      const isHovered =
        this.effectiveHoveredType === 'company' && this.effectiveHoveredKey === compKey;
      const isSelected = this.currentLevel === 3 && this.activeCompanyKey === compKey;
      const targetHighlight = isSelected || isHovered ? 1.0 : 0.0;

      rec.highlightMix = THREE.MathUtils.lerp(
        rec.highlightMix,
        targetHighlight,
        fastHighlightLerp
      );

      rec.outlineLineMat.opacity = rec.highlightMix * 0.98;
      rec.shellMat.opacity = rec.highlightMix * (isSelected ? 0.16 : 0.12);
      rec.apronRingMat.opacity = rec.highlightMix * 0.95;

      if (rec.liveBeaconRing) {
        const sPulse = 1 + 0.15 * Math.sin(this.elapsedTime * 4.0);
        rec.liveBeaconRing.scale.set(sPulse, sPulse, 1);
      }

      if (Math.abs(rec.opacityMix - rec.targetOpacityMix) > 0.002) {
        rec.opacityMix = THREE.MathUtils.lerp(rec.opacityMix, rec.targetOpacityMix, dimLerp);
        for (const mat of rec.dimmableMaterials) {
          const baseOp = mat.userData?.baseOpacity ?? 1.0;
          mat.opacity = baseOp * rec.opacityMix;
          mat.depthWrite = rec.opacityMix > 0.55;
        }
      }
    }
  }

  _projectScreenAnchorsAndCompass() {
    const width = this.canvas.clientWidth || window.innerWidth || 1280;
    const height = this.canvas.clientHeight || window.innerHeight || 720;

    if (typeof this.onCompassUpdate === 'function') {
      this.camera.getWorldDirection(this._camDirVec);
      const azimuthRad = Math.atan2(this._camDirVec.x, -this._camDirVec.z);
      const deg = ((azimuthRad * 180) / Math.PI + 360) % 360;
      this.onCompassUpdate(deg);
    }

    if (typeof this.onScreenAnchorsUpdate !== 'function') return;

    const anchors = [];

    if (this.currentLevel === 1) {
      for (const [kcnCode, rec] of this.kcnRecords) {
        if (
          this.activeProvinceCode &&
          rec.data.province_code &&
          rec.data.province_code !== this.activeProvinceCode
        ) {
          continue;
        }
        const projected = this._projectWorldPoint(rec.anchorWorldPos, width, height);
        anchors.push({
          key: kcnCode,
          id: kcnCode,
          type: 'kcn',
          kcnCode,
          industrial_park_code: kcnCode,
          companyKey: null,
          company_key: null,
          x: projected.x,
          y: projected.y,
          visible: projected.visible,
          distance: projected.distance,
          hovered: this.effectiveHoveredType === 'kcn' && this.effectiveHoveredKey === kcnCode,
          selected: this.activeKcnCode === kcnCode,
          level: 1,
          data: rec.data,
        });
      }
    } else {
      const kcnRec = this.kcnRecords.get(this.activeKcnCode);
      const companyList = kcnRec
        ? kcnRec.companyRecords
        : Array.from(this.companyRecords.values());

      for (const compRec of companyList) {
        const projected = this._projectWorldPoint(compRec.anchorWorldPos, width, height);
        anchors.push({
          key: compRec.companyKey,
          id: compRec.companyKey,
          type: 'company',
          kcnCode: compRec.kcnCode,
          industrial_park_code: compRec.kcnCode,
          companyKey: compRec.companyKey,
          company_key: compRec.companyKey,
          x: projected.x,
          y: projected.y,
          visible: projected.visible,
          distance: projected.distance,
          hovered:
            this.effectiveHoveredType === 'company' &&
            this.effectiveHoveredKey === compRec.companyKey,
          selected: this.activeCompanyKey === compRec.companyKey,
          level: this.currentLevel,
          data: compRec.data,
        });
      }
    }

    this.onScreenAnchorsUpdate(anchors);
  }

  _projectWorldPoint(worldPos, width, height) {
    this._projVec.copy(worldPos);
    const distance = this.camera.position.distanceTo(worldPos);
    this._projVec.project(this.camera);

    const isBehindCamera = this._projVec.z > 1.0 || this._projVec.z < -1.0;
    const x = (this._projVec.x * 0.5 + 0.5) * width;
    const y = (-(this._projVec.y * 0.5) + 0.5) * height;
    const margin = 80;
    const inViewport =
      !isBehindCamera &&
      x >= -margin &&
      x <= width + margin &&
      y >= -margin &&
      y <= height + margin;

    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      visible: inViewport,
      distance: Math.round(distance * 10) / 10,
    };
  }

  /* ==========================================================================
   * 13. RESIZE & CLEANUP LIFECYCLE
   * ========================================================================== */

  _syncCameraViewOffset(width, height, immediate = false, dt = 0.016) {
    const targetOffsetX = 0; // Canvas occupies its own column next to the results.

    if (immediate || this.currentViewOffsetX === undefined) {
      this.currentViewOffsetX = targetOffsetX;
    } else if (Math.abs(this.currentViewOffsetX - targetOffsetX) > 0.5) {
      const lerpFactor = 1 - Math.exp(-dt * 14);
      this.currentViewOffsetX = THREE.MathUtils.lerp(
        this.currentViewOffsetX,
        targetOffsetX,
        lerpFactor
      );
    } else {
      this.currentViewOffsetX = targetOffsetX;
    }

    const roundedOffset = Math.round(this.currentViewOffsetX);
    if (Math.abs(roundedOffset) > 0) {
      this.camera.setViewOffset(width, height, roundedOffset, 0, width, height);
    } else {
      this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
    }
  }

  resize() {
    if (this.isDisposed) return;
    const width = this.canvas.clientWidth || window.innerWidth || 1280;
    const height = this.canvas.clientHeight || window.innerHeight || 720;
    this.camera.aspect = width / Math.max(height, 1);
    this._syncCameraViewOffset(width, height, true);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  dispose() {
    this.isDisposed = true;
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
    this._clearSceneObjects();
    for (const tex of this.textureCache.values()) {
      tex.dispose();
    }
    this.textureCache.clear();
    this.renderer.dispose();
  }
}

export default BiSpatial3DEngine;
