import {formatRecruitmentPostVnd} from "../../recruitment-posts/recruitment-post-ui-model.ts";
/**
 * BI Feed -> 3D Spatial Recruitment Hierarchy Adapter (Real Geographic GPS & Map Tile Edition)
 * Transforms BI public feed (`https://bi.hrpartner.vn/feeds/jobs.v1.json` / `GET /api/live-bi-feed`)
 * into a deterministic 3-tier spatial hierarchy for Three.js & Glassmorphic HUD:
 *   Level 1: Macro Northern Vietnam Provinces & 13 Canonical Industrial Parks (KCN) with Real GPS & Map Tiles
 *   Level 2: KCN Master-Plan Zone -> Real Polygon Boundaries, Internal Roads, Zoom-15 Map Tiles & Company Compounds
 *   Level 3: Company Compound -> Real Factory GPS, 4-Side Camera Orbit Poses & Active Recruitment Posts (`jobs.v1`)
 */

export const LABOR_TYPE_LABELS = Object.freeze({
  TEMPORARY: 'Thời vụ',
  PERMANENT: 'Chính thức',
});

export const SHIFT_PATTERN_LABELS = Object.freeze({
  DAY_ONLY: 'Chuyên ngày',
  TWO_SHIFTS: 'Hai ca',
  THREE_SHIFTS: 'Ba ca',
  OTHER: 'Khác',
});

export const ENVIRONMENT_TYPE_LABELS = Object.freeze({
  CLEAN_ROOM: 'Phòng sạch',
  SEMI_CLEAN_ROOM: 'Phòng bán sạch',
  NORMAL_ROOM: 'Phòng thường',
});

export const WORK_POSTURE_LABELS = Object.freeze({
  STANDING: 'Đứng',
  SITTING: 'Ngồi',
});

export const GENDER_REQUIREMENT_LABELS = Object.freeze({
  FEMALE: 'Nữ',
  MALE: 'Nam',
  ANY: 'Nam/Nữ',
});

export const EDUCATION_REQUIREMENT_LABELS = Object.freeze({
  SECONDARY: 'THCS (Cấp 2)',
  HIGH_SCHOOL: 'THPT (Cấp 3)',
  NONE: 'Không yêu cầu',
});

export const SHIFT_RATE_FIELDS = Object.freeze([
  { key: 'day_shift_8h_vnd', label: 'Ca ngày 8h', shortLabel: 'Ngày 8h' },
  { key: 'day_shift_11h_vnd', label: 'Ca ngày 12h (11h công)', shortLabel: 'Ngày 12h' },
  { key: 'night_shift_8h_vnd', label: 'Ca đêm 8h', shortLabel: 'Đêm 8h' },
  { key: 'night_shift_11h_vnd', label: 'Ca đêm 12h (11h công)', shortLabel: 'Đêm 12h' },
  { key: 'sunday_day_11h_vnd', label: 'Chủ nhật ngày', shortLabel: 'CN ngày' },
  { key: 'sunday_night_11h_vnd', label: 'Chủ nhật đêm', shortLabel: 'CN đêm' },
  { key: 'holiday_day_11h_vnd', label: 'Ngày Lễ (ca ngày)', shortLabel: 'Lễ ngày' },
  { key: 'holiday_night_11h_vnd', label: 'Ngày Lễ (ca đêm)', shortLabel: 'Lễ đêm' },
]);

export const DOCUMENT_CHECKLIST_FIELDS = Object.freeze([
  { key: 'require_original_cccd_and_copy', label: 'CCCD bản gốc & bản sao' },
  { key: 'require_certified_resume', label: 'Sơ yếu lý lịch có xác nhận' },
  { key: 'require_health_certificate_within_6_months', label: 'Giấy khám sức khỏe (trong 6 tháng)' },
  { key: 'require_photo_3x4', label: 'Ảnh thẻ 3x4' },
  { key: 'require_degree_or_certificate', label: 'Bằng tốt nghiệp / Chứng chỉ' },
  { key: 'require_social_insurance_book', label: 'Sổ / Mã số BHXH' },
  { key: 'require_other_documents', label: 'Giấy tờ khác (Xác nhận cư trú / dân sự)' },
]);

/* ==========================================================================
 * 1. REAL NORTHERN VIETNAM GEOGRAPHIC PROJECTION & SLIPPY MAP TILE MATH
 * ========================================================================== */

export const ORIGIN_LAT = 21.30;
export const ORIGIN_LNG = 105.68;
export const COS_ORIGIN_LAT = Math.cos((ORIGIN_LAT * Math.PI) / 180);
export const GEO_SCALE = 380; // 1° latitude = 380 world units; 1° longitude ≈ 354.03 world units

export const GEO_BOUNDS = Object.freeze({
  originLat: ORIGIN_LAT,
  originLng: ORIGIN_LNG,
  cosOriginLat: COS_ORIGIN_LAT,
  scale: GEO_SCALE,
  minLat: 20.76,
  maxLat: 21.60,
  minLng: 104.92,
  maxLng: 106.32,
  macroZoom: 10,
  kcnZoom: 15,
});

export function formatGpsDisplay(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return '21.3000°N, 105.6800°E';
  }
  const ns = latNum >= 0 ? 'N' : 'S';
  const ew = lngNum >= 0 ? 'E' : 'W';
  return `${Math.abs(latNum).toFixed(4)}°${ns}, ${Math.abs(lngNum).toFixed(4)}°${ew}`;
}

export function buildGoogleMapsUrl(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return 'https://www.google.com/maps?q=21.3000,105.6800';
  }
  return `https://www.google.com/maps?q=${latNum.toFixed(6)},${lngNum.toFixed(6)}`;
}

/**
 * Projects real `(lat, lng)` to 3D World Coordinates `[x, y, z]`.
 * Returns a hybrid Array `[x, y, z]` that also exposes `.x`, `.y`, `.z`, `.lat`, `.lng`
 * so both `const [x, y, z] = latLngToWorld(...)` and `const { x, z } = latLngToWorld(...)` work.
 */
export function latLngToWorld(lat, lng, y = 0) {
  const latNum = Number(lat) || ORIGIN_LAT;
  const lngNum = Number(lng) || ORIGIN_LNG;
  const yNum = Number(y) || 0;
  const x = Number(((lngNum - ORIGIN_LNG) * COS_ORIGIN_LAT * GEO_SCALE).toFixed(2));
  const z = Number((-(latNum - ORIGIN_LAT) * GEO_SCALE).toFixed(2));
  const tuple = [x, yNum, z];
  tuple.x = x;
  tuple.y = yNum;
  tuple.z = z;
  tuple.lat = latNum;
  tuple.lng = lngNum;
  return tuple;
}

/**
 * Inverse projection from 3D World `(x, z)` back to real `(lat, lng)`.
 * Returns a hybrid Array `[lat, lng]` with `.lat`, `.lng`, `.gpsDisplay`, `.googleMapsUrl`.
 */
export function worldToLatLng(x, z) {
  const xNum = Number(x) || 0;
  const zNum = Number(z) || 0;
  const lat = Number((ORIGIN_LAT - zNum / GEO_SCALE).toFixed(6));
  const lng = Number((ORIGIN_LNG + xNum / (COS_ORIGIN_LAT * GEO_SCALE)).toFixed(6));
  const tuple = [lat, lng];
  tuple.lat = lat;
  tuple.lng = lng;
  tuple.gpsDisplay = formatGpsDisplay(lat, lng);
  tuple.googleMapsUrl = buildGoogleMapsUrl(lat, lng);
  return tuple;
}

/**
 * Web Mercator (`EPSG:3857`) `(lat, lng, zoom)` -> Slippy Map tile coordinates `(x, y)`.
 */
export function latLngToTileXY(lat, lng, zoom = 10) {
  const z = Math.max(0, Math.min(19, Math.floor(Number(zoom) || 10)));
  const n = 2 ** z;
  const latClamped = Math.max(-85.0511, Math.min(85.0511, Number(lat) || ORIGIN_LAT));
  const lngClamped = Number(lng) || ORIGIN_LNG;
  const xFloat = ((lngClamped + 180) / 360) * n;
  const latRad = (latClamped * Math.PI) / 180;
  const yFloat =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.max(0, Math.min(n - 1, Math.floor(xFloat)));
  const tileY = Math.max(0, Math.min(n - 1, Math.floor(yFloat)));
  const res = [tileX, tileY, z];
  res.zoom = z;
  res.z = z;
  res.x = tileX;
  res.y = tileY;
  res.tileX = tileX;
  res.tileY = tileY;
  res.xFloat = xFloat;
  res.yFloat = yFloat;
  res.u = xFloat - tileX;
  res.v = yFloat - tileY;
  return res;
}

/**
 * Web Mercator Slippy Map tile `(tileX, tileY, zoom)` -> Geographic bounding box & NW corner `(lat, lng)`.
 */
export function tileXYToLatLng(tileX, tileY, zoom = 10) {
  const z = Math.max(0, Math.min(19, Math.floor(Number(zoom) || 10)));
  const n = 2 ** z;
  const tx = Number(tileX) || 0;
  const ty = Number(tileY) || 0;

  const tileToLng = (xVal) => (xVal / n) * 360 - 180;
  const tileToLat = (yVal) => {
    const rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yVal) / n)));
    return (rad * 180) / Math.PI;
  };

  const north = Number(tileToLat(ty).toFixed(6));
  const south = Number(tileToLat(ty + 1).toFixed(6));
  const west = Number(tileToLng(tx).toFixed(6));
  const east = Number(tileToLng(tx + 1).toFixed(6));
  const centerLat = Number(((north + south) * 0.5).toFixed(6));
  const centerLng = Number(((west + east) * 0.5).toFixed(6));

  const res = [north, west];
  res.lat = north;
  res.lng = west;
  res.north = north;
  res.south = south;
  res.west = west;
  res.east = east;
  res.centerLat = centerLat;
  res.centerLng = centerLng;
  return res;
}

/**
 * Builds the Level 1 Macro Map tile grid (`zoom = 10`, covering Phú Thọ, Vĩnh Phúc, Bắc Giang, Hòa Bình)
 * with exact 3D world bounds (`worldBounds`) for each tile and for the stitched macro ground plane.
 */
export function getMacroMapTileGrid({
  zoom = GEO_BOUNDS.macroZoom,
  style = 'street',
  minLat = GEO_BOUNDS.minLat,
  maxLat = GEO_BOUNDS.maxLat,
  minLng = GEO_BOUNDS.minLng,
  maxLng = GEO_BOUNDS.maxLng,
} = {}) {
  const normalizedStyle = style === 'satellite' ? 'satellite' : 'street';
  const nwTile = latLngToTileXY(maxLat, minLng, zoom);
  const seTile = latLngToTileXY(minLat, maxLng, zoom);

  const minTileX = Math.min(nwTile.tileX, seTile.tileX);
  const maxTileX = Math.max(nwTile.tileX, seTile.tileX);
  const minTileY = Math.min(nwTile.tileY, seTile.tileY);
  const maxTileY = Math.max(nwTile.tileY, seTile.tileY);

  const cols = maxTileX - minTileX + 1;
  const rows = maxTileY - minTileY + 1;

  const gridNW = tileXYToLatLng(minTileX, minTileY, zoom);
  const gridSE = tileXYToLatLng(maxTileX, maxTileY, zoom);
  const worldNW = latLngToWorld(gridNW.north, gridNW.west);
  const worldSE = latLngToWorld(gridSE.south, gridSE.east);

  const gridMinX = Math.min(worldNW.x, worldSE.x);
  const gridMaxX = Math.max(worldNW.x, worldSE.x);
  const gridMinZ = Math.min(worldNW.z, worldSE.z);
  const gridMaxZ = Math.max(worldNW.z, worldSE.z);

  const tiles = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const col = tx - minTileX;
      const row = ty - minTileY;
      const tBounds = tileXYToLatLng(tx, ty, zoom);
      const tNW = latLngToWorld(tBounds.north, tBounds.west);
      const tSE = latLngToWorld(tBounds.south, tBounds.east);
      const minX = Math.min(tNW.x, tSE.x);
      const maxX = Math.max(tNW.x, tSE.x);
      const minZ = Math.min(tNW.z, tSE.z);
      const maxZ = Math.max(tNW.z, tSE.z);

      tiles.push({
        z: zoom,
        x: tx,
        y: ty,
        col,
        row,
        style: normalizedStyle,
        boundsLatLng: {
          north: tBounds.north,
          south: tBounds.south,
          west: tBounds.west,
          east: tBounds.east,
          centerLat: tBounds.centerLat,
          centerLng: tBounds.centerLng,
        },
        worldBounds: {
          minX,
          maxX,
          minZ,
          maxZ,
          centerX: Number(((minX + maxX) * 0.5).toFixed(2)),
          centerZ: Number(((minZ + maxZ) * 0.5).toFixed(2)),
          width: Number((maxX - minX).toFixed(2)),
          depth: Number((maxZ - minZ).toFixed(2)),
        },
      });
    }
  }

  return {
    zoom,
    style: normalizedStyle,
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
    cols,
    rows,
    boundsLatLng: {
      north: gridNW.north,
      south: gridSE.south,
      west: gridNW.west,
      east: gridSE.east,
      centerLat: Number(((gridNW.north + gridSE.south) * 0.5).toFixed(6)),
      centerLng: Number(((gridNW.west + gridSE.east) * 0.5).toFixed(6)),
    },
    worldBounds: {
      minX: gridMinX,
      maxX: gridMaxX,
      minZ: gridMinZ,
      maxZ: gridMaxZ,
      centerX: Number(((gridMinX + gridMaxX) * 0.5).toFixed(2)),
      centerZ: Number(((gridMinZ + gridMaxZ) * 0.5).toFixed(2)),
      width: Number((gridMaxX - gridMinX).toFixed(2)),
      depth: Number((gridMaxZ - gridMinZ).toFixed(2)),
    },
    tiles,
  };
}

/**
 * Real Northern Vietnam Highway Corridors with GPS polylines (`latLngPoints`) & 3D World Polylines (`worldPoints`).
 */
const RAW_HIGHWAY_CORRIDORS = [
  {
    id: 'CT05',
    code: 'CT.05',
    name: 'Cao tốc Nội Bài – Lào Cai (CT.05)',
    color: '#0284c7',
    latLngPoints: [
      [21.2180, 105.8040], // Nội Bài Airport Hub
      [21.2580, 105.7120], // Bình Xuyên (Vĩnh Phúc)
      [21.3180, 105.6780], // IC4 Bá Thiện / Tam Hợp
      [21.3050, 105.6050], // IC5 Vĩnh Yên
      [21.3390, 105.3620], // IC7 Việt Trì / KCN Thụy Vân
      [21.4250, 105.2380], // IC9 TX. Phú Thọ / KCN Phú Hà
      [21.4360, 105.0580], // IC10 Cẩm Khê / KCN Cẩm Khê
    ],
  },
  {
    id: 'CT01',
    code: 'CT.01 / QL1A',
    name: 'Cao tốc Hà Nội – Bắc Giang (CT.01 / QL1A)',
    color: '#10b981',
    latLngPoints: [
      [21.0520, 105.8950], // Gia Lâm / Cầu Thanh Trì Hà Nội
      [21.1320, 105.9780], // Từ Sơn (Bắc Ninh)
      [21.1980, 106.0860], // Cầu Như Nguyệt (Sông Cầu)
      [21.2225, 106.1210], // KCN Quang Châu (Việt Yên)
      [21.2490, 106.1430], // KCN Vân Trung (Việt Yên)
      [21.2650, 106.1560], // KCN Đình Trám (Việt Yên)
      [21.2880, 106.1980], // TP. Bắc Giang
    ],
  },
  {
    id: 'QL18',
    code: 'QL.18',
    name: 'Quốc lộ 18 Nội Bài – Bắc Ninh – Bắc Giang',
    color: '#f59e0b',
    latLngPoints: [
      [21.2210, 105.8060], // Nội Bài
      [21.2080, 105.9480], // Yên Phong (Bắc Ninh)
      [21.1860, 106.0750], // TP. Bắc Ninh
      [21.2225, 106.1210], // KCN Quang Châu
    ],
  },
  {
    id: 'QL2',
    code: 'QL.2',
    name: 'Quốc lộ 2 Nội Bài – Vĩnh Yên – Việt Trì',
    color: '#0ea5e9',
    latLngPoints: [
      [21.2210, 105.8020], // Nội Bài
      [21.2580, 105.6820], // KCN Bình Xuyên 1
      [21.2985, 105.6190], // KCN Khai Quang (TP. Vĩnh Yên)
      [21.3392, 105.3564], // KCN Thụy Vân (TP. Việt Trì)
    ],
  },
  {
    id: 'QL6',
    code: 'QL.6 / ĐL Thăng Long',
    name: 'Đại lộ Thăng Long – Quốc lộ 6 – Hòa Bình',
    color: '#f97316',
    latLngPoints: [
      [21.0060, 105.7880], // Trung tâm Hội nghị Quốc gia Hà Nội
      [20.9950, 105.5520], // Khu CNC Hòa Lạc
      [20.9120, 105.5680], // Xuân Mai
      [20.8920, 105.5240], // KCN Lương Sơn (Hòa Bình)
    ],
  },
];

export const HIGHWAY_POLYLINES = Object.freeze(
  RAW_HIGHWAY_CORRIDORS.map((corridor) => {
    const worldPoints = corridor.latLngPoints.map(([lat, lng]) => latLngToWorld(lat, lng, 0.08));
    const points2D = worldPoints.map((pt) => [pt.x, pt.z]);
    return Object.freeze({
      ...corridor,
      worldPoints,
      points: points2D,
    });
  }),
);

/* ==========================================================================
 * 2. CANONICAL MACRO NORTHERN VIETNAM PROVINCES IN BI CATALOG
 * ========================================================================== */

export const SPATIAL_PROVINCES = Object.freeze([
  {
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    region_tag: 'Trục Nội Bài – Quốc lộ 2 – Bình Xuyên & Vĩnh Yên',
    lat: 21.2980,
    lng: 105.6730,
    gpsDisplay: formatGpsDisplay(21.2980, 105.6730),
    googleMapsUrl: buildGoogleMapsUrl(21.2980, 105.6730),
    mapPosition: [-4, 0, -2],
    plateauDimensions: [148, 2.2, 152],
    color: '#10b981',
    cameraOverviewPose: {
      position: [-4, 148, 138],
      target: [-4, 0, -2],
    },
  },
  {
    province_code: 'PHU_THO',
    province_name: 'Phú Thọ',
    region_tag: 'Cao tốc Nội Bài – Lào Cai (CT.05) & Sông Hồng',
    lat: 21.4008,
    lng: 105.2171,
    gpsDisplay: formatGpsDisplay(21.4008, 105.2171),
    googleMapsUrl: buildGoogleMapsUrl(21.4008, 105.2171),
    mapPosition: [-180, 0, -46],
    plateauDimensions: [165, 2.2, 105],
    color: '#06b6d4',
    cameraOverviewPose: {
      position: [-180, 132, 76],
      target: [-180, 0, -46],
    },
  },
  {
    province_code: 'BAC_GIANG',
    province_name: 'Bắc Giang',
    region_tag: 'Cao tốc Hà Nội – Bắc Giang (CT.01 / QL1A)',
    lat: 21.2455,
    lng: 106.1400,
    gpsDisplay: formatGpsDisplay(21.2455, 106.1400),
    googleMapsUrl: buildGoogleMapsUrl(21.2455, 106.1400),
    mapPosition: [172, 0, 6],
    plateauDimensions: [118, 2.2, 146],
    color: '#3b82f6',
    cameraOverviewPose: {
      position: [172, 132, 122],
      target: [172, 0, 6],
    },
  },
  {
    province_code: 'HOA_BINH',
    province_name: 'Hòa Bình',
    region_tag: 'Hành lang Hòa Lạc – Quốc lộ 6 Tây Nam',
    lat: 20.8920,
    lng: 105.5240,
    gpsDisplay: formatGpsDisplay(20.8920, 105.5240),
    googleMapsUrl: buildGoogleMapsUrl(20.8920, 105.5240),
    mapPosition: [-62, 0, 152],
    plateauDimensions: [92, 2.2, 78],
    color: '#f59e0b',
    cameraOverviewPose: {
      position: [-62, 118, 238],
      target: [-62, 0, 152],
    },
  },
]);

/* ==========================================================================
 * 3. ALL 13 CANONICAL BI INDUSTRIAL PARKS (KCN) WITH REAL GPS, POLYGONS & ROADS
 * ========================================================================== */

/**
 * Builds a realistic multi-vertex geographic polygon (`boundaryLatLng`), local 3D polygon (`boundaryPolygon`),
 * and world 3D polygon (`boundaryWorldPolygon`) for each KCN.
 */
function buildKcnPolygonData(centerLat, centerLng, worldPos, padDims, shapeProfile = []) {
  const [padW, padD] = padDims;
  const halfW = padW * 0.5;
  const halfD = padD * 0.5;
  // Approximate real KCN extent in degrees (~1.6km x ~1.1km around centerLat, centerLng)
  const degHalfLng = 0.0082;
  const degHalfLat = 0.0056;

  const vertices =
    Array.isArray(shapeProfile) && shapeProfile.length >= 6
      ? shapeProfile
      : [
          [-0.92, -0.78],
          [-0.25, -0.96],
          [0.64, -0.92],
          [0.98, -0.35],
          [0.94, 0.72],
          [0.35, 0.96],
          [-0.76, 0.92],
          [-0.98, 0.18],
        ];

  const boundaryLatLng = vertices.map(([nx, nz]) => [
    Number((centerLat - nz * degHalfLat).toFixed(6)),
    Number((centerLng + nx * degHalfLng).toFixed(6)),
  ]);

  const boundaryPolygon = vertices.map(([nx, nz]) => [
    Number((nx * halfW).toFixed(2)),
    Number((nz * halfD).toFixed(2)),
  ]);

  const boundaryWorldPolygon = boundaryPolygon.map(([lx, lz]) => [
    Number((worldPos[0] + lx).toFixed(2)),
    Number((worldPos[2] + lz).toFixed(2)),
  ]);

  return {
    boundaryLatLng,
    boundaryPolygon,
    boundaryWorldPolygon,
  };
}

/**
 * Builds the internal KCN road network (main entrance boulevard + twin cross avenues + perimeter service road)
 * in both KCN local coordinates (`points`) and 3D world coordinates (`worldPoints`) for 3D vehicle routing.
 */
function buildKcnInternalRoads(worldPos, padDims) {
  const [padW, padD] = padDims;
  const halfW = padW * 0.46;
  const halfD = padD * 0.45;
  const wx = worldPos[0];
  const wy = worldPos[1] || 0;
  const wz = worldPos[2];

  const toWorld = (pts) =>
    pts.map(([lx, lz]) => [Number((wx + lx).toFixed(2)), wy + 0.68, Number((wz + lz).toFixed(2))]);

  const mainBoulevardPts = [
    [-halfW, 0],
    [-7, 0],
    [0, 0],
    [7, 0],
    [halfW, 0],
  ];
  const westAvenuePts = [
    [-7, halfD],
    [-7, 0],
    [-7, -halfD],
  ];
  const eastAvenuePts = [
    [7, -halfD],
    [7, 0],
    [7, halfD],
  ];
  const gateApproachPts = [
    [0, halfD + 3.5],
    [0, halfD * 0.78],
    [-7, halfD * 0.78],
    [7, halfD * 0.78],
  ];
  const perimeterLoopPts = [
    [-halfW * 0.88, -halfD * 0.82],
    [halfW * 0.88, -halfD * 0.82],
    [halfW * 0.88, halfD * 0.82],
    [-halfW * 0.88, halfD * 0.82],
    [-halfW * 0.88, -halfD * 0.82],
  ];

  return [
    {
      id: 'main_ew_boulevard',
      name: 'Trục đại lộ trung tâm KCN',
      type: 'boulevard',
      width: 3.8,
      lanes: 2,
      points: mainBoulevardPts,
      worldPoints: toWorld(mainBoulevardPts),
    },
    {
      id: 'west_ns_avenue',
      name: 'Đường nội khu Tây (Lô A-B)',
      type: 'avenue',
      width: 2.4,
      lanes: 2,
      points: westAvenuePts,
      worldPoints: toWorld(westAvenuePts),
    },
    {
      id: 'east_ns_avenue',
      name: 'Đường nội khu Đông (Lô B-C)',
      type: 'avenue',
      width: 2.4,
      lanes: 2,
      points: eastAvenuePts,
      worldPoints: toWorld(eastAvenuePts),
    },
    {
      id: 'gate_entrance_axis',
      name: 'Cổng chính KCN & Quảng trường đón xe ca',
      type: 'entrance',
      width: 3.4,
      lanes: 2,
      points: gateApproachPts,
      worldPoints: toWorld(gateApproachPts),
    },
    {
      id: 'perimeter_loop',
      name: 'Đường vành đai KCN',
      type: 'perimeter',
      width: 2.0,
      lanes: 2,
      points: perimeterLoopPts,
      worldPoints: toWorld(perimeterLoopPts),
    },
  ];
}

/**
 * Builds the Level 2/3 High-Zoom (`zoom = 15`) real map tile grid for a specific KCN.
 */
export function getKcnMapTileGrid(
  kcnOrCode,
  { zoom = GEO_BOUNDS.kcnZoom, style = 'street', radiusTiles = 1 } = {},
) {
  const normalizedStyle = style === 'satellite' ? 'satellite' : 'street';
  let kcn = null;
  if (typeof kcnOrCode === 'string') {
    kcn = SPATIAL_KCNS.find((item) => item.industrial_park_code === kcnOrCode) || null;
  } else if (kcnOrCode && typeof kcnOrCode === 'object') {
    kcn = kcnOrCode;
  }

  const lat = Number(kcn?.lat) || ORIGIN_LAT;
  const lng = Number(kcn?.lng) || ORIGIN_LNG;
  const worldPos = Array.isArray(kcn?.worldPosition) ? kcn.worldPosition : latLngToWorld(lat, lng);
  const padDims = Array.isArray(kcn?.padDimensions) ? kcn.padDimensions : [54, 36];
  const padW = Number(padDims[0]) || 54;
  const padD = Number(padDims[1]) || 36;

  const centerTile = latLngToTileXY(lat, lng, zoom);
  const r = Math.max(1, Math.min(2, Math.floor(Number(radiusTiles) || 1)));
  const minTileX = centerTile.tileX - r;
  const maxTileX = centerTile.tileX + r;
  const minTileY = centerTile.tileY - r;
  const maxTileY = centerTile.tileY + r;
  const cols = maxTileX - minTileX + 1;
  const rows = maxTileY - minTileY + 1;

  const gridNW = tileXYToLatLng(minTileX, minTileY, zoom);
  const gridSE = tileXYToLatLng(maxTileX, maxTileY, zoom);

  // Map the 3x3 high-zoom tile grid onto the KCN pad local expanse (with a 1.15x context collar around the KCN pad)
  const localSpanW = padW * 1.15;
  const localSpanD = padD * 1.15;
  const localMinX = -localSpanW * 0.5;
  const localMaxX = localSpanW * 0.5;
  const localMinZ = -localSpanD * 0.5;
  const localMaxZ = localSpanD * 0.5;

  const tileStepW = localSpanW / cols;
  const tileStepD = localSpanD / rows;

  const tiles = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const col = tx - minTileX;
      const row = ty - minTileY;
      const tBounds = tileXYToLatLng(tx, ty, zoom);
      const tLocalMinX = Number((localMinX + col * tileStepW).toFixed(2));
      const tLocalMaxX = Number((tLocalMinX + tileStepW).toFixed(2));
      const tLocalMinZ = Number((localMinZ + row * tileStepD).toFixed(2));
      const tLocalMaxZ = Number((tLocalMinZ + tileStepD).toFixed(2));

      tiles.push({
        z: zoom,
        x: tx,
        y: ty,
        col,
        row,
        style: normalizedStyle,
        boundsLatLng: {
          north: tBounds.north,
          south: tBounds.south,
          west: tBounds.west,
          east: tBounds.east,
          centerLat: tBounds.centerLat,
          centerLng: tBounds.centerLng,
        },
        localBounds: {
          minX: tLocalMinX,
          maxX: tLocalMaxX,
          minZ: tLocalMinZ,
          maxZ: tLocalMaxZ,
          centerX: Number(((tLocalMinX + tLocalMaxX) * 0.5).toFixed(2)),
          centerZ: Number(((tLocalMinZ + tLocalMaxZ) * 0.5).toFixed(2)),
          width: Number(tileStepW.toFixed(2)),
          depth: Number(tileStepD.toFixed(2)),
        },
        worldBounds: {
          minX: Number((worldPos[0] + tLocalMinX).toFixed(2)),
          maxX: Number((worldPos[0] + tLocalMaxX).toFixed(2)),
          minZ: Number((worldPos[2] + tLocalMinZ).toFixed(2)),
          maxZ: Number((worldPos[2] + tLocalMaxZ).toFixed(2)),
          centerX: Number((worldPos[0] + (tLocalMinX + tLocalMaxX) * 0.5).toFixed(2)),
          centerZ: Number((worldPos[2] + (tLocalMinZ + tLocalMaxZ) * 0.5).toFixed(2)),
          width: Number(tileStepW.toFixed(2)),
          depth: Number(tileStepD.toFixed(2)),
        },
      });
    }
  }

  return {
    industrial_park_code: kcn?.industrial_park_code || null,
    zoom,
    style: normalizedStyle,
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
    cols,
    rows,
    boundsLatLng: {
      north: gridNW.north,
      south: gridSE.south,
      west: gridNW.west,
      east: gridSE.east,
      centerLat: lat,
      centerLng: lng,
    },
    localBounds: {
      minX: Number(localMinX.toFixed(2)),
      maxX: Number(localMaxX.toFixed(2)),
      minZ: Number(localMinZ.toFixed(2)),
      maxZ: Number(localMaxZ.toFixed(2)),
      width: Number(localSpanW.toFixed(2)),
      depth: Number(localSpanD.toFixed(2)),
    },
    worldBounds: {
      minX: Number((worldPos[0] + localMinX).toFixed(2)),
      maxX: Number((worldPos[0] + localMaxX).toFixed(2)),
      minZ: Number((worldPos[2] + localMinZ).toFixed(2)),
      maxZ: Number((worldPos[2] + localMaxZ).toFixed(2)),
      centerX: worldPos[0],
      centerZ: worldPos[2],
      width: Number(localSpanW.toFixed(2)),
      depth: Number(localSpanD.toFixed(2)),
    },
    tiles,
  };
}

const RAW_KCN_DEFINITIONS = [
  {
    industrial_park_code: 'VP_BA_THIEN_1',
    industrial_park_name: 'KCN Bá Thiện 1',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'Bình Xuyên, Vĩnh Phúc',
    highwayCorridor: 'Cao tốc Nội Bài – Lào Cai (IC4 · ĐT310B)',
    lat: 21.3365,
    lng: 105.6760,
    worldPosition: [-14, 0, -52],
    padDimensions: [54, 36],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.95, -0.72],
      [-0.38, -0.96],
      [0.52, -0.94],
      [0.96, -0.44],
      [0.92, 0.68],
      [0.34, 0.96],
      [-0.68, 0.92],
      [-0.98, 0.24],
    ],
  },
  {
    industrial_park_code: 'VP_BA_THIEN_2',
    industrial_park_name: 'KCN Bá Thiện 2',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'Bình Xuyên, Vĩnh Phúc',
    highwayCorridor: 'Cao tốc Nội Bài – Lào Cai (ĐT310 · Thiện Kế)',
    lat: 21.3188,
    lng: 105.6865,
    worldPosition: [44, 0, -36],
    padDimensions: [54, 36],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.92, -0.82],
      [-0.18, -0.98],
      [0.72, -0.88],
      [0.98, -0.22],
      [0.88, 0.78],
      [0.22, 0.96],
      [-0.78, 0.88],
      [-0.98, 0.12],
    ],
  },
  {
    industrial_park_code: 'VP_BINH_XUYEN_1',
    industrial_park_name: 'KCN Bình Xuyên 1',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'Bình Xuyên, Vĩnh Phúc',
    highwayCorridor: 'Quốc lộ 2 – Thị trấn Hương Canh & Đạo Đức',
    lat: 21.2580,
    lng: 105.6820,
    worldPosition: [-24, 0, 58],
    padDimensions: [54, 36],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.96, -0.68],
      [-0.28, -0.94],
      [0.66, -0.92],
      [0.98, -0.32],
      [0.94, 0.74],
      [0.38, 0.96],
      [-0.72, 0.92],
      [-0.98, 0.22],
    ],
  },
  {
    industrial_park_code: 'VP_BINH_XUYEN_2',
    industrial_park_name: 'KCN Bình Xuyên 2',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'Bình Xuyên, Vĩnh Phúc',
    highwayCorridor: 'Quốc lộ 2 – Bá Hiến & Sơn Lôi',
    lat: 21.2695,
    lng: 105.7025,
    worldPosition: [38, 0, 42],
    padDimensions: [50, 34],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.88, -0.84],
      [0.12, -0.96],
      [0.86, -0.78],
      [0.98, 0.08],
      [0.84, 0.86],
      [-0.14, 0.96],
      [-0.88, 0.82],
    ],
  },
  {
    industrial_park_code: 'VP_KHAI_QUANG',
    industrial_park_name: 'KCN Khai Quang',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'TP. Vĩnh Yên, Vĩnh Phúc',
    highwayCorridor: 'Phường Khai Quang – TP. Vĩnh Yên (QL2)',
    lat: 21.2985,
    lng: 105.6190,
    worldPosition: [-62, 0, -4],
    padDimensions: [52, 34],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.94, -0.64],
      [-0.36, -0.96],
      [0.58, -0.92],
      [0.96, -0.36],
      [0.92, 0.66],
      [0.32, 0.96],
      [-0.68, 0.90],
      [-0.98, 0.18],
    ],
  },
  {
    industrial_park_code: 'VP_THANG_LONG_3',
    industrial_park_name: 'KCN Thăng Long 3',
    province_code: 'VINH_PHUC',
    province_name: 'Vĩnh Phúc',
    district_name: 'Bình Xuyên, Vĩnh Phúc',
    highwayCorridor: 'ĐT310 – Thiện Kế & Tam Hợp (Sumitomo IP)',
    lat: 21.2910,
    lng: 105.6720,
    worldPosition: [-6, 0, 4],
    padDimensions: [52, 34],
    zoneColor: '#10b981',
    shapeProfile: [
      [-0.92, -0.86],
      [0.0, -0.96],
      [0.92, -0.86],
      [0.98, 0.0],
      [0.92, 0.86],
      [0.0, 0.96],
      [-0.92, 0.86],
      [-0.98, 0.0],
    ],
  },
  {
    industrial_park_code: 'PT_PHU_HA',
    industrial_park_name: 'KCN Phú Hà',
    province_code: 'PHU_THO',
    province_name: 'Phú Thọ',
    district_name: 'TX. Phú Thọ, Phú Thọ',
    highwayCorridor: 'Cao tốc Nội Bài – Lào Cai (IC9 · đường Hồ Chí Minh)',
    lat: 21.4285,
    lng: 105.2358,
    worldPosition: [-178, 0, -52],
    padDimensions: [56, 36],
    zoneColor: '#06b6d4',
    shapeProfile: [
      [-0.95, -0.74],
      [-0.24, -0.96],
      [0.68, -0.90],
      [0.98, -0.28],
      [0.90, 0.76],
      [0.24, 0.96],
      [-0.76, 0.90],
      [-0.98, 0.16],
    ],
  },
  {
    industrial_park_code: 'PT_CAM_KHE',
    industrial_park_name: 'KCN Cẩm Khê',
    province_code: 'PHU_THO',
    province_name: 'Phú Thọ',
    district_name: 'Cẩm Khê, Phú Thọ',
    highwayCorridor: 'Cao tốc Nội Bài – Lào Cai (IC10 · Sông Hồng)',
    lat: 21.4347,
    lng: 105.0592,
    worldPosition: [-242, 0, -62],
    padDimensions: [56, 36],
    zoneColor: '#06b6d4',
    shapeProfile: [
      [-0.94, -0.68],
      [-0.30, -0.95],
      [0.62, -0.92],
      [0.96, -0.34],
      [0.92, 0.72],
      [0.30, 0.96],
      [-0.72, 0.88],
      [-0.98, 0.14],
    ],
  },
  {
    industrial_park_code: 'PT_THUY_VAN',
    industrial_park_name: 'KCN Thụy Vân',
    province_code: 'PHU_THO',
    province_name: 'Phú Thọ',
    district_name: 'TP. Việt Trì, Phú Thọ',
    highwayCorridor: 'Cao tốc CT.05 (IC7) – TP. Việt Trì – Quốc lộ 2',
    lat: 21.3392,
    lng: 105.3564,
    worldPosition: [-122, 0, -24],
    padDimensions: [50, 34],
    zoneColor: '#06b6d4',
    shapeProfile: [
      [-0.90, -0.80],
      [-0.15, -0.96],
      [0.74, -0.86],
      [0.98, -0.18],
      [0.88, 0.78],
      [0.18, 0.96],
      [-0.78, 0.86],
      [-0.98, 0.10],
    ],
  },
  {
    industrial_park_code: 'HB_LUONG_SON',
    industrial_park_name: 'KCN Lương Sơn',
    province_code: 'HOA_BINH',
    province_name: 'Hòa Bình',
    district_name: 'Lương Sơn, Hòa Bình',
    highwayCorridor: 'Quốc lộ 6 – Hòa Sơn, Lương Sơn (Cửa ngõ Tây Nam)',
    lat: 20.8920,
    lng: 105.5240,
    worldPosition: [-62, 0, 152],
    padDimensions: [52, 34],
    zoneColor: '#f59e0b',
    shapeProfile: [
      [-0.92, -0.76],
      [-0.22, -0.96],
      [0.68, -0.88],
      [0.98, -0.24],
      [0.90, 0.74],
      [0.26, 0.96],
      [-0.74, 0.88],
      [-0.98, 0.14],
    ],
  },
  {
    industrial_park_code: 'BG_QUANG_CHAU',
    industrial_park_name: 'KCN Quang Châu',
    province_code: 'BAC_GIANG',
    province_name: 'Bắc Giang',
    district_name: 'Việt Yên, Bắc Giang',
    highwayCorridor: 'Cao tốc Hà Nội – Bắc Giang (CT.01 / QL1A · Sông Cầu)',
    lat: 21.2225,
    lng: 106.1210,
    worldPosition: [142, 0, 56],
    padDimensions: [56, 36],
    zoneColor: '#3b82f6',
    shapeProfile: [
      [-0.94, -0.76],
      [-0.26, -0.96],
      [0.66, -0.90],
      [0.98, -0.30],
      [0.92, 0.76],
      [0.32, 0.96],
      [-0.74, 0.90],
      [-0.98, 0.20],
    ],
  },
  {
    industrial_park_code: 'BG_VAN_TRUNG',
    industrial_park_name: 'KCN Vân Trung',
    province_code: 'BAC_GIANG',
    province_name: 'Bắc Giang',
    district_name: 'Việt Yên, Bắc Giang',
    highwayCorridor: 'Cao tốc Hà Nội – Bắc Giang (CT.01 / QL1A)',
    lat: 21.2490,
    lng: 106.1430,
    worldPosition: [172, 0, 6],
    padDimensions: [54, 36],
    zoneColor: '#3b82f6',
    shapeProfile: [
      [-0.92, -0.80],
      [-0.18, -0.96],
      [0.72, -0.88],
      [0.98, -0.22],
      [0.88, 0.78],
      [0.20, 0.96],
      [-0.76, 0.88],
      [-0.98, 0.12],
    ],
  },
  {
    industrial_park_code: 'BG_DINH_TRAM',
    industrial_park_name: 'KCN Đình Trám',
    province_code: 'BAC_GIANG',
    province_name: 'Bắc Giang',
    district_name: 'Việt Yên, Bắc Giang',
    highwayCorridor: 'Nút giao Quốc lộ 1A & Quốc lộ 37 (Việt Yên)',
    lat: 21.2650,
    lng: 106.1560,
    worldPosition: [204, 0, -44],
    padDimensions: [50, 34],
    zoneColor: '#3b82f6',
    shapeProfile: [
      [-0.90, -0.78],
      [-0.20, -0.96],
      [0.68, -0.88],
      [0.96, -0.24],
      [0.88, 0.76],
      [0.22, 0.95],
      [-0.74, 0.88],
      [-0.96, 0.16],
    ],
  },
];

export const SPATIAL_KCNS = Object.freeze(
  RAW_KCN_DEFINITIONS.map((rawKcn) => {
    const geoWorldPos = latLngToWorld(rawKcn.lat, rawKcn.lng, 0);
    const polyData = buildKcnPolygonData(
      rawKcn.lat,
      rawKcn.lng,
      rawKcn.worldPosition,
      rawKcn.padDimensions,
      rawKcn.shapeProfile,
    );
    const internalRoads = buildKcnInternalRoads(rawKcn.worldPosition, rawKcn.padDimensions);
    const mapTileRegion = getKcnMapTileGrid(rawKcn, { zoom: GEO_BOUNDS.kcnZoom, style: 'street' });

    return Object.freeze({
      industrial_park_code: rawKcn.industrial_park_code,
      industrial_park_name: rawKcn.industrial_park_name,
      province_code: rawKcn.province_code,
      province_name: rawKcn.province_name,
      district_name: rawKcn.district_name,
      highwayCorridor: rawKcn.highwayCorridor,
      lat: rawKcn.lat,
      lng: rawKcn.lng,
      gpsDisplay: formatGpsDisplay(rawKcn.lat, rawKcn.lng),
      googleMapsUrl: buildGoogleMapsUrl(rawKcn.lat, rawKcn.lng),
      worldPosition: rawKcn.worldPosition,
      geoWorldPosition: [geoWorldPos.x, 0, geoWorldPos.z],
      padDimensions: rawKcn.padDimensions,
      zoneColor: rawKcn.zoneColor,
      boundaryLatLng: polyData.boundaryLatLng,
      boundaryPolygon: polyData.boundaryPolygon,
      boundaryWorldPolygon: polyData.boundaryWorldPolygon,
      internalRoads,
      mapTileRegion,
    });
  }),
);

export const GEO_PROJECTION = Object.freeze({
  ORIGIN_LAT,
  ORIGIN_LNG,
  COS_ORIGIN_LAT,
  SCALE: GEO_SCALE,
  GEO_BOUNDS,
  latLngToWorld,
  worldToLatLng,
  latLngToTileXY,
  tileXYToLatLng,
  formatGpsDisplay,
  buildGoogleMapsUrl,
  getMacroMapTileGrid,
  getKcnMapTileGrid,
  HIGHWAY_POLYLINES,
});

/**
 * Deterministic Plot Local Coordinates inside any KCN Compound (around internal east-west boulevard z = 0)
 */
const KCN_PLOT_SLOTS = Object.freeze([
  [-14, 0, -9.5],
  [0, 0, -9.5],
  [14, 0, -9.5],
  [-14, 0, 9.5],
  [0, 0, 9.5],
  [14, 0, 9.5],
  [-26, 0, -9.5],
  [26, 0, -9.5],
  [-26, 0, 9.5],
  [26, 0, 9.5],
]);

/**
 * Real-world & realistic factory parcel GPS coordinates inside each KCN for all 34+ known companies.
 */
const KNOWN_COMPANY_GPS_CATALOG = Object.freeze([
  // VP_BA_THIEN_2 (`[21.3188, 105.6865]`)
  { kcn: 'VP_BA_THIEN_2', match: 'tal viet nam', lat: 21.3198, lng: 105.6845 },
  { kcn: 'VP_BA_THIEN_2', match: 'optrontech', lat: 21.3172, lng: 105.6888 },
  { kcn: 'VP_BA_THIEN_2', match: 'dai thang', lat: 21.3212, lng: 105.6872 },
  // VP_BA_THIEN_1 (`[21.3365, 105.6760]`)
  { kcn: 'VP_BA_THIEN_1', match: 'compal', lat: 21.3382, lng: 105.6738 },
  { kcn: 'VP_BA_THIEN_1', match: 'tkdt', lat: 21.3374, lng: 105.6768 },
  { kcn: 'VP_BA_THIEN_1', match: 'aac technologies', lat: 21.3352, lng: 105.6784 },
  { kcn: 'VP_BA_THIEN_1', match: 'vitalink', lat: 21.3346, lng: 105.6742 },
  { kcn: 'VP_BA_THIEN_1', match: 'minh duc', lat: 21.3360, lng: 105.6725 },
  { kcn: 'VP_BA_THIEN_1', match: 'heasung', lat: 21.3390, lng: 105.6775 },
  { kcn: 'VP_BA_THIEN_1', match: 'bhflex', lat: 21.3378, lng: 105.6795 },
  { kcn: 'VP_BA_THIEN_1', match: 'vina korea', lat: 21.3340, lng: 105.6762 },
  // VP_BINH_XUYEN_1 (`[21.2580, 105.6820]`)
  { kcn: 'VP_BINH_XUYEN_1', match: 'cdl precision', lat: 21.2594, lng: 105.6798 },
  { kcn: 'VP_BINH_XUYEN_1', match: 'hyundai ht', lat: 21.2586, lng: 105.6828 },
  { kcn: 'VP_BINH_XUYEN_1', match: 'piaggio', lat: 21.2564, lng: 105.6845 },
  { kcn: 'VP_BINH_XUYEN_1', match: 'ltv', lat: 21.2572, lng: 105.6792 },
  { kcn: 'VP_BINH_XUYEN_1', match: 'we sum', lat: 21.2598, lng: 105.6840 },
  // VP_BINH_XUYEN_2 (`[21.2695, 105.7025]`)
  { kcn: 'VP_BINH_XUYEN_2', match: 'kci vina', lat: 21.2704, lng: 105.7016 },
  // VP_KHAI_QUANG (`[21.2985, 105.6190]`)
  { kcn: 'VP_KHAI_QUANG', match: 'jahwa', lat: 21.2998, lng: 105.6174 },
  { kcn: 'VP_KHAI_QUANG', match: 'bhflex', lat: 21.2972, lng: 105.6208 },
  // VP_THANG_LONG_3 (`[21.2910, 105.6720]`)
  { kcn: 'VP_THANG_LONG_3', match: 'valuetronics', lat: 21.2918, lng: 105.6712 },
  // PT_PHU_HA (`[21.4285, 105.2358]`)
  { kcn: 'PT_PHU_HA', match: 'jh vina', lat: 21.4302, lng: 105.2336 },
  { kcn: 'PT_PHU_HA', match: 'coronet', lat: 21.4294, lng: 105.2364 },
  { kcn: 'PT_PHU_HA', match: 'sjg asentec', lat: 21.4288, lng: 105.2388 },
  { kcn: 'PT_PHU_HA', match: 'hanyang digitech', lat: 21.4272, lng: 105.2340 },
  { kcn: 'PT_PHU_HA', match: 'arp vina', lat: 21.4268, lng: 105.2366 },
  { kcn: 'PT_PHU_HA', match: 'hrobot', lat: 21.4276, lng: 105.2392 },
  { kcn: 'PT_PHU_HA', match: 'byd', lat: 21.4310, lng: 105.2372 },
  { kcn: 'PT_PHU_HA', match: 'asahi intecc', lat: 21.4262, lng: 105.2352 },
  { kcn: 'PT_PHU_HA', match: 'tinh ha', lat: 21.4305, lng: 105.2350 },
  // PT_CAM_KHE (`[21.4347, 105.0592]`)
  { kcn: 'PT_CAM_KHE', match: 'yi da', lat: 21.4362, lng: 105.0572 },
  { kcn: 'PT_CAM_KHE', match: 'sunrise', lat: 21.4354, lng: 105.0598 },
  { kcn: 'PT_CAM_KHE', match: 'ssep', lat: 21.4342, lng: 105.0616 },
  { kcn: 'PT_CAM_KHE', match: 'inst magnetic', lat: 21.4334, lng: 105.0578 },
  { kcn: 'PT_CAM_KHE', match: 'hwa sung', lat: 21.4330, lng: 105.0604 },
  // PT_THUY_VAN (`[21.3392, 105.3564]`)
  { kcn: 'PT_THUY_VAN', match: 'namuga', lat: 21.3404, lng: 105.3552 },
  // BG_QUANG_CHAU (`[21.2225, 106.1210]`)
  { kcn: 'BG_QUANG_CHAU', match: 'luxshare', lat: 21.2242, lng: 106.1188 },
  { kcn: 'BG_QUANG_CHAU', match: 'foxconn', lat: 21.2214, lng: 106.1232 },
  { kcn: 'BG_QUANG_CHAU', match: 'ja solar', lat: 21.2236, lng: 106.1225 },
  // BG_VAN_TRUNG (`[21.2490, 106.1430]`)
  { kcn: 'BG_VAN_TRUNG', match: 'sj tech', lat: 21.2502, lng: 106.1418 },
  { kcn: 'BG_VAN_TRUNG', match: 'luxshare', lat: 21.2482, lng: 106.1446 },
  // BG_DINH_TRAM (`[21.2650, 106.1560]`)
  { kcn: 'BG_DINH_TRAM', match: 'hosiden', lat: 21.2658, lng: 106.1552 },
  // HB_LUONG_SON (`[20.8920, 105.5240]`)
  { kcn: 'HB_LUONG_SON', match: 'nissin', lat: 20.8928, lng: 105.5232 },
]);

function resolveCompanyGps(kcn, customerName, plotIndex) {
  const normalizedName = normalizeSlugText(customerName).replace(/-/g, ' ');
  const kcnCode = kcn.industrial_park_code;

  for (const entry of KNOWN_COMPANY_GPS_CATALOG) {
    if (entry.kcn === kcnCode && normalizedName.includes(entry.match)) {
      return {
        lat: entry.lat,
        lng: entry.lng,
        gpsDisplay: formatGpsDisplay(entry.lat, entry.lng),
        googleMapsUrl: buildGoogleMapsUrl(entry.lat, entry.lng),
      };
    }
  }

  // Deterministic parcel offset inside KCN polygon around (kcn.lat, kcn.lng)
  const slot = KCN_PLOT_SLOTS[plotIndex % KCN_PLOT_SLOTS.length];
  const baseLat = Number(kcn.lat) || ORIGIN_LAT;
  const baseLng = Number(kcn.lng) || ORIGIN_LNG;
  const lat = Number((baseLat - slot[2] * 0.00022).toFixed(6));
  const lng = Number((baseLng + slot[0] * 0.00024).toFixed(6));
  return {
    lat,
    lng,
    gpsDisplay: formatGpsDisplay(lat, lng),
    googleMapsUrl: buildGoogleMapsUrl(lat, lng),
  };
}

export function parseVndNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9]/g, '');
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function formatVnd(value) { return formatRecruitmentPostVnd(value == null ? null : String(value));
}

export function formatCompactVnd(value, { fallback = 'Thỏa thuận' } = {}) {
  const num = parseVndNumber(value);
  if (!num || num <= 0) return fallback;
  const millions = num / 1_000_000;
  if (millions >= 1) {
    const formatted = Number.isInteger(millions)
      ? String(millions)
      : millions.toFixed(1).replace('.', ',');
    return `${formatted} tr`;
  }
  return `${num.toLocaleString('vi-VN')} ₫`;
}

export function formatIncomeRange(comp, { compact = false } = {}) {
  if (!comp || typeof comp !== 'object') return 'Thỏa thuận';
  const minVal = parseVndNumber(comp.average_income_min_vnd);
  const maxVal = parseVndNumber(comp.average_income_max_vnd);
  const baseVal = parseVndNumber(comp.base_salary_vnd);

  if (minVal > 0 && maxVal > 0) {
    if (compact) {
      return minVal === maxVal
        ? `${formatCompactVnd(maxVal)}/tháng`
        : `${formatCompactVnd(minVal)} – ${formatCompactVnd(maxVal)}/tháng`;
    }
    return minVal === maxVal
      ? `${formatVnd(maxVal)}/tháng`
      : `${formatVnd(minVal)} – ${formatVnd(maxVal)}/tháng`;
  }
  if (maxVal > 0) {
    return `Tới ${compact ? formatCompactVnd(maxVal) : formatVnd(maxVal)}/tháng`;
  }
  if (minVal > 0) {
    return `Từ ${compact ? formatCompactVnd(minVal) : formatVnd(minVal)}/tháng`;
  }
  if (baseVal > 0) {
    return `LCB: ${compact ? formatCompactVnd(baseVal) : formatVnd(baseVal)}/tháng`;
  }
  return 'Thỏa thuận';
}

export function normalizeSlugText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildShortCompanyName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) return 'Nhà máy KCN';
  const stripped = raw
    .replace(
      /^công\s*ty\s*(tnhh|cổ\s*phần|cp)\s*(sản\s*xuất\s*tmdv|sx\s*&\s*tm|sản\s*xuất|công\s*nghiệp|điện\s*tử)?\s*/i,
      '',
    )
    .trim();
  return stripped.length >= 3 ? stripped : raw;
}

function resolveBuildingArchetype(envTypes = []) {
  if (!Array.isArray(envTypes) || envTypes.length === 0) {
    return 'NORMAL_ROOM';
  }
  if (envTypes.includes('CLEAN_ROOM')) return 'CLEAN_ROOM';
  if (envTypes.includes('SEMI_CLEAN_ROOM')) return 'SEMI_CLEAN_ROOM';
  return 'NORMAL_ROOM';
}

function buildOrbitPoses(worldPos, buildingDims) {
  const [wx, , wz] = worldPos;
  const [, bh] = buildingDims;
  const targetY = Math.max(2.2, bh * 0.48);
  const camY = Math.max(17, bh * 2.8 + 8);
  const radius = 27;

  return {
    south: {
      side: 'south',
      label: 'Góc nhìn 1 · Nam',
      shortLabel: 'Nam',
      position: [wx, camY, wz + radius],
      target: [wx, targetY, wz],
    },
    east: {
      side: 'east',
      label: 'Góc nhìn 2 · Đông',
      shortLabel: 'Đông',
      position: [wx + radius, camY, wz],
      target: [wx, targetY, wz],
    },
    north: {
      side: 'north',
      label: 'Góc nhìn 3 · Bắc',
      shortLabel: 'Bắc',
      position: [wx, camY, wz - radius],
      target: [wx, targetY, wz],
    },
    west: {
      side: 'west',
      label: 'Góc nhìn 4 · Tây',
      shortLabel: 'Tây',
      position: [wx - radius, camY, wz],
      target: [wx, targetY, wz],
    },
  };
}

export function buildBiSpatialHierarchy(rawJobs) {
  // Map provinces and KCN templates
  const provinceCatalogMap = new Map(
    SPATIAL_PROVINCES.map((p) => [p.province_code, { ...p }]),
  );
  const kcnCatalogMap = new Map(
    SPATIAL_KCNS.map((k) => [
      k.industrial_park_code,
      {
        ...k,
        cameraZonePose: {
          position: [k.worldPosition[0], 38, k.worldPosition[2] + 52],
          target: [k.worldPosition[0], 1.5, k.worldPosition[2]],
        },
        companiesMap: new Map(),
        companies: [],
        jobs: [],
      },
    ]),
  );

  const enrichedJobs = [];

  for (const rawJob of rawJobs) {
    if (!rawJob || typeof rawJob !== 'object') continue;
    const loc = rawJob.location || {};
    const gen = rawJob.general || {};
    const cand = rawJob.candidate || {};
    const comp = rawJob.compensation || {};
    const docs = rawJob.documents || {};

    const province_code = loc.province_code;
    const province_name = loc.province_name;
    const industrial_park_code = loc.industrial_park_code;
    const industrial_park_name = loc.industrial_park_name;

    if (!provinceCatalogMap.has(province_code)) {
      provinceCatalogMap.set(province_code, {
        province_code,
        province_name,
        region_tag: 'Khu công nghiệp miền Bắc',
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        gpsDisplay: formatGpsDisplay(ORIGIN_LAT, ORIGIN_LNG),
        googleMapsUrl: buildGoogleMapsUrl(ORIGIN_LAT, ORIGIN_LNG),
        mapPosition: [0, 0, 120],
        plateauDimensions: [110, 2.2, 95],
        color: '#10b981',
        cameraOverviewPose: {
          position: [0, 130, 210],
          target: [0, 0, 120],
        },
      });
    }

    if (!kcnCatalogMap.has(industrial_park_code)) {
      const fallbackX = (kcnCatalogMap.size % 5) * 75 - 150;
      const fallbackZ = Math.floor(kcnCatalogMap.size / 5) * 75;
      const fallbackLatLng = worldToLatLng(fallbackX, fallbackZ);
      const fallbackWorldPos = [fallbackX, 0, fallbackZ];
      const fallbackPadDims = [52, 34];
      const polyData = buildKcnPolygonData(
        fallbackLatLng.lat,
        fallbackLatLng.lng,
        fallbackWorldPos,
        fallbackPadDims,
      );
      kcnCatalogMap.set(industrial_park_code, {
        industrial_park_code,
        industrial_park_name,
        province_code,
        province_name,
        district_name: province_name,
        highwayCorridor: 'Hành lang công nghiệp miền Bắc',
        lat: fallbackLatLng.lat,
        lng: fallbackLatLng.lng,
        gpsDisplay: fallbackLatLng.gpsDisplay,
        googleMapsUrl: fallbackLatLng.googleMapsUrl,
        worldPosition: fallbackWorldPos,
        geoWorldPosition: fallbackWorldPos,
        padDimensions: fallbackPadDims,
        zoneColor: '#10b981',
        boundaryLatLng: polyData.boundaryLatLng,
        boundaryPolygon: polyData.boundaryPolygon,
        boundaryWorldPolygon: polyData.boundaryWorldPolygon,
        internalRoads: buildKcnInternalRoads(fallbackWorldPos, fallbackPadDims),
        mapTileRegion: getKcnMapTileGrid({
          industrial_park_code,
          lat: fallbackLatLng.lat,
          lng: fallbackLatLng.lng,
          worldPosition: fallbackWorldPos,
          padDimensions: fallbackPadDims,
        }),
        cameraZonePose: {
          position: [fallbackX, 38, fallbackZ + 52],
          target: [fallbackX, 1.5, fallbackZ],
        },
        companiesMap: new Map(),
        companies: [],
        jobs: [],
      });
    }

    const kcnEntry = kcnCatalogMap.get(industrial_park_code);
    const customer_name = (gen.customer_name || 'Doanh nghiệp KCN').trim();
    const normalizedCustomer = normalizeSlugText(customer_name) || 'company';
    const company_key = `${industrial_park_code}__${normalizedCustomer}`;
    const public_slug = rawJob.public_slug;

    const laborTypes = Array.isArray(gen.labor_types) ? gen.labor_types : [];
    const envTypes = Array.isArray(gen.environment_types) ? gen.environment_types : [];
    const workPostures = Array.isArray(gen.work_postures) ? gen.work_postures : [];

    const incomeMinNum = parseVndNumber(comp.average_income_min_vnd);
    const incomeMaxNum = parseVndNumber(comp.average_income_max_vnd);
    const baseSalaryNum = parseVndNumber(comp.base_salary_vnd);
    const effectiveMaxIncome = Math.max(incomeMaxNum, incomeMinNum, baseSalaryNum);
    const effectiveMinIncome =
      incomeMinNum > 0
        ? incomeMinNum
        : incomeMaxNum > 0
          ? incomeMaxNum
          : baseSalaryNum;


    const enrichedJob = {
      ...rawJob,
      id: rawJob.id || rawJob.brief_id,
      brief_id: rawJob.brief_id || rawJob.id,
      company_key,
      company_short_name: buildShortCompanyName(customer_name),
      public_slug,
      income_min_num: effectiveMinIncome,
      income_max_num: effectiveMaxIncome,
      base_salary_num: baseSalaryNum,
      income_range_display: formatIncomeRange(comp),
      income_range_compact: formatIncomeRange(comp, { compact: true }),
      base_salary_display: formatVnd(comp.base_salary_vnd),
      labor_types_display:
        laborTypes
          .map((lt) => lt.display_name || LABOR_TYPE_LABELS[lt.labor_type_key] || lt.labor_type_key)
          .join(' · ') || 'Thời vụ',
      environment_types_display:
        envTypes.map((e) => ENVIRONMENT_TYPE_LABELS[e] || e).join(', ') || 'Phòng thường',
      work_postures_display:
        workPostures.map((p) => WORK_POSTURE_LABELS[p] || p).join(', ') || 'Đứng / Ngồi',
      shift_pattern_display:
        SHIFT_PATTERN_LABELS[gen.shift_pattern] || gen.shift_pattern || 'Hai ca',
      education_display:
        EDUCATION_REQUIREMENT_LABELS[cand.education_requirement] || 'Không yêu cầu',
      gender_display:
        cand.gender_label || GENDER_REQUIREMENT_LABELS[cand.gender_requirement] || 'Nam/Nữ',
      age_range_display:
        cand.age_min && cand.age_max
          ? `${cand.age_min} – ${cand.age_max} tuổi`
          : cand.age_min
            ? `Từ ${cand.age_min} tuổi`
            : '18 – 45 tuổi',
      location: {
        province_code,
        province_name,
        industrial_park_code,
        industrial_park_name,
      },
      general: gen,
      candidate: cand,
      compensation: comp,
      documents: docs,
    };

    enrichedJobs.push(enrichedJob);
    kcnEntry.jobs.push(enrichedJob);

    if (!kcnEntry.companiesMap.has(company_key)) {
      kcnEntry.companiesMap.set(company_key, {
        company_key,
        customer_name,
        short_name: buildShortCompanyName(customer_name),
        industrial_park_code,
        industrial_park_name,
        province_code,
        province_name,
        investment_origin: gen.investment_origin || 'FDI / Doanh nghiệp KCN',
        manufacturing_industry: gen.manufacturing_industry || 'Sản xuất công nghiệp & linh kiện',
        envTypesSet: new Set(),
        laborTypeKeysSet: new Set(),
        shiftPatternsSet: new Set(),
        jobs: [],
        total_expected_headcount: 0,
        min_income_vnd: 0,
        max_income_vnd: 0,
        has_salary_advance: false,
      });
    }

    const companyAcc = kcnEntry.companiesMap.get(company_key);
    companyAcc.jobs.push(enrichedJob);
    for (const e of envTypes) companyAcc.envTypesSet.add(e);
    for (const lt of laborTypes) {
      if (lt?.labor_type_key) companyAcc.laborTypeKeysSet.add(lt.labor_type_key);
    }
    if (gen.shift_pattern) companyAcc.shiftPatternsSet.add(gen.shift_pattern);
    companyAcc.total_expected_headcount += Number(gen.expected_headcount || 0);
    if (effectiveMinIncome > 0) {
      companyAcc.min_income_vnd =
        companyAcc.min_income_vnd === 0
          ? effectiveMinIncome
          : Math.min(companyAcc.min_income_vnd, effectiveMinIncome);
    }
    if (effectiveMaxIncome > companyAcc.max_income_vnd) {
      companyAcc.max_income_vnd = effectiveMaxIncome;
    }
    if (comp.salary_advance_available) companyAcc.has_salary_advance = true;
  }

  // Finalize companies & KCNs
  const allCompanies = [];
  const industrial_parks = [];

  for (const kcn of kcnCatalogMap.values()) {
    const rawCompanies = Array.from(kcn.companiesMap.values());
    const finalizedCompanies = rawCompanies.map((compAcc, idx) => {
      const slot = KCN_PLOT_SLOTS[idx % KCN_PLOT_SLOTS.length];
      const plotLocalPosition = [slot[0], slot[1], slot[2]];
      const plotWorldPosition = [
        kcn.worldPosition[0] + slot[0],
        kcn.worldPosition[1] + slot[1],
        kcn.worldPosition[2] + slot[2],
      ];

      const companyGps = resolveCompanyGps(kcn, compAcc.customer_name, idx);
      const envArray = Array.from(compAcc.envTypesSet);
      const buildingArchetype = resolveBuildingArchetype(envArray);

      // Deterministic 3D architectural building dimensions based on headcount & job count
      const headcountFactor = Math.min(
        1.45,
        Math.max(0.85, Math.log10(Math.max(50, compAcc.total_expected_headcount)) / 2.4),
      );
      const width = Number((7.2 * headcountFactor).toFixed(2));
      const height = Number(
        (
          (buildingArchetype === 'CLEAN_ROOM'
            ? 5.6
            : buildingArchetype === 'SEMI_CLEAN_ROOM'
              ? 4.8
              : 4.2) * Math.min(1.3, 0.9 + compAcc.jobs.length * 0.12)
        ).toFixed(2),
      );
      const depth = Number((5.2 * headcountFactor).toFixed(2));
      const buildingDimensions = [width, height, depth];

      const plotCode = `Lô #${String(idx + 1).padStart(2, '0')}`;
      for (const j of compAcc.jobs) {
        j.plotCode = plotCode;
        j.buildingArchetype = buildingArchetype;
        j.lat = companyGps.lat;
        j.lng = companyGps.lng;
        j.gpsDisplay = companyGps.gpsDisplay;
        j.googleMapsUrl = companyGps.googleMapsUrl;
      }

      const laborTypeKeys = Array.from(compAcc.laborTypeKeysSet);
      const shiftPatterns = Array.from(compAcc.shiftPatternsSet);

      const finalizedCompany = {
        company_key: compAcc.company_key,
        customer_name: compAcc.customer_name,
        short_name: compAcc.short_name,
        industrial_park_code: kcn.industrial_park_code,
        industrial_park_name: kcn.industrial_park_name,
        province_code: kcn.province_code,
        province_name: kcn.province_name,
        investment_origin: compAcc.investment_origin,
        manufacturing_industry: compAcc.manufacturing_industry,
        primary_environment_type: buildingArchetype,
        environment_label: ENVIRONMENT_TYPE_LABELS[buildingArchetype] || 'Phòng thường',
        buildingArchetype,
        lat: companyGps.lat,
        lng: companyGps.lng,
        gpsDisplay: companyGps.gpsDisplay,
        googleMapsUrl: companyGps.googleMapsUrl,
        plotIndex: idx,
        plotCode,
        plotLocalPosition,
        plotWorldPosition,
        roofWorldPosition: [
          plotWorldPosition[0],
          plotWorldPosition[1] + height + 2.6,
          plotWorldPosition[2],
        ],
        buildingDimensions,
        orbitPoses: buildOrbitPoses(plotWorldPosition, buildingDimensions),
        job_count: compAcc.jobs.length,
        total_expected_headcount: compAcc.total_expected_headcount,
        min_income_vnd: compAcc.min_income_vnd,
        max_income_vnd: compAcc.max_income_vnd,
        income_range_display: formatIncomeRange({
          average_income_min_vnd: String(compAcc.min_income_vnd || ''),
          average_income_max_vnd: String(compAcc.max_income_vnd || ''),
        }),
        income_range_compact: formatIncomeRange(
          {
            average_income_min_vnd: String(compAcc.min_income_vnd || ''),
            average_income_max_vnd: String(compAcc.max_income_vnd || ''),
          },
          { compact: true },
        ),
        max_income_display: formatVnd(compAcc.max_income_vnd),
        has_salary_advance: compAcc.has_salary_advance,
        labor_type_keys: laborTypeKeys,
        labor_types_display:
          laborTypeKeys.map((k) => LABOR_TYPE_LABELS[k] || k).join(' · ') || 'Thời vụ',
        shift_patterns: shiftPatterns,
        jobs: compAcc.jobs,
      };

      allCompanies.push(finalizedCompany);
      return finalizedCompany;
    });

    const totalHeadcount = finalizedCompanies.reduce(
      (sum, c) => sum + c.total_expected_headcount,
      0,
    );
    const minIncome = finalizedCompanies.reduce((min, c) => {
      if (!c.min_income_vnd) return min;
      return min === 0 ? c.min_income_vnd : Math.min(min, c.min_income_vnd);
    }, 0);
    const maxIncome = finalizedCompanies.reduce(
      (max, c) => Math.max(max, c.max_income_vnd || 0),
      0,
    );

    industrial_parks.push({
      industrial_park_code: kcn.industrial_park_code,
      industrial_park_name: kcn.industrial_park_name,
      province_code: kcn.province_code,
      province_name: kcn.province_name,
      district_name: kcn.district_name,
      highwayCorridor: kcn.highwayCorridor,
      lat: kcn.lat,
      lng: kcn.lng,
      gpsDisplay: kcn.gpsDisplay,
      googleMapsUrl: kcn.googleMapsUrl,
      worldPosition: kcn.worldPosition,
      geoWorldPosition: kcn.geoWorldPosition,
      padDimensions: kcn.padDimensions,
      boundaryLatLng: kcn.boundaryLatLng,
      boundaryPolygon: kcn.boundaryPolygon,
      boundaryWorldPolygon: kcn.boundaryWorldPolygon,
      internalRoads: kcn.internalRoads,
      mapTileRegion: kcn.mapTileRegion,
      zoneColor: kcn.jobs.length > 0 ? kcn.zoneColor : '#475569',
      accentColor: kcn.zoneColor,
      cameraZonePose: kcn.cameraZonePose,
      company_count: finalizedCompanies.length,
      job_count: kcn.jobs.length,
      total_headcount: totalHeadcount,
      min_income_vnd: minIncome,
      max_income_vnd: maxIncome,
      income_range_display:
        maxIncome > 0
          ? formatIncomeRange({
              average_income_min_vnd: String(minIncome),
              average_income_max_vnd: String(maxIncome),
            })
          : 'Đang cập nhật',
      max_income_display: maxIncome > 0 ? formatVnd(maxIncome) : '—',
      max_income_compact: maxIncome > 0 ? formatCompactVnd(maxIncome) : '—',
      companies: finalizedCompanies,
      jobs: kcn.jobs,
    });
  }

  const provinces = [];
  for (const prov of provinceCatalogMap.values()) {
    const provKcns = industrial_parks.filter(
      (k) => k.province_code === prov.province_code,
    );
    const activeKcns = provKcns.filter((k) => k.job_count > 0);
    const companyCount = provKcns.reduce((sum, k) => sum + k.company_count, 0);
    const jobCount = provKcns.reduce((sum, k) => sum + k.job_count, 0);
    const totalHeadcount = provKcns.reduce((sum, k) => sum + k.total_headcount, 0);
    const maxIncome = provKcns.reduce(
      (max, k) => Math.max(max, k.max_income_vnd || 0),
      0,
    );
    const minIncome = provKcns.reduce((min, k) => {
      if (!k.min_income_vnd) return min;
      return min === 0 ? k.min_income_vnd : Math.min(min, k.min_income_vnd);
    }, 0);

    provinces.push({
      ...prov,
      kcn_count: provKcns.length,
      active_kcn_count: activeKcns.length,
      company_count: companyCount,
      job_count: jobCount,
      total_headcount: totalHeadcount,
      min_income_vnd: minIncome,
      max_income_vnd: maxIncome,
      max_income_display: maxIncome > 0 ? formatVnd(maxIncome) : '—',
      max_income_compact: maxIncome > 0 ? formatCompactVnd(maxIncome) : '—',
      industrial_parks: provKcns,
    });
  }

  const totalHeadcount = enrichedJobs.reduce(
    (sum, j) => sum + Number(j.general?.expected_headcount || 0),
    0,
  );
  const globalMaxIncome = enrichedJobs.reduce(
    (max, j) => Math.max(max, j.income_max_num || 0),
    0,
  );

  return {
    meta: {
      total_jobs: enrichedJobs.length,
      total_companies: allCompanies.length,
      total_kcns: industrial_parks.length,
      total_active_kcns: industrial_parks.filter((k) => k.job_count > 0).length,
      total_headcount: totalHeadcount,
      max_income_vnd: globalMaxIncome,
      max_income_display: formatVnd(globalMaxIncome),
      geo_bounds: GEO_BOUNDS,
    },
    geo: GEO_PROJECTION,
    macroMapTileGrid: getMacroMapTileGrid({ zoom: GEO_BOUNDS.macroZoom, style: 'street' }),
    highwayPolylines: HIGHWAY_POLYLINES,
    provinces,
    industrial_parks,
    companies: allCompanies,
    jobs: enrichedJobs,
  };
}

