/**
 * P1-T1-W04-R6 — Global color theme registry (single source of truth).
 *
 * - 5 theme, mỗi theme có bộ token light + dark (dark được derive từ light).
 * - Semantic status colors cố định (emerald/amber/rose/sky/slate) độc lập theme.
 * - Thuần (không import React/value module khác) để Node test chạy được.
 * - Không chứa secret/PII.
 */

export type ColorMode = "light" | "dark";

export interface ThemeTokens {
  bg: string;
  fg: string;
  surface: string;
  muted: string;
  border: string;
  primary: string;
  secondary: string;
  accent: string;
  ring: string;
  tooltip: string;
  onPrimary: string;
  chart: string[];
}

export interface ThemeDef {
  id: string;
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

// ---------------------------------------------------------------------------
// Color math (hex <-> HSL) — dùng để derive dark tokens từ light seeds.
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

/** Tăng lightness về phía trắng (amount 0..1). */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const nl = Math.min(1, l + (1 - l) * amount);
  const [nr, ng, nb] = hslToRgb(h, s, nl);
  return rgbToHex(nr, ng, nb);
}

/** Giảm lightness về phía đen (amount 0..1). */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const nl = Math.max(0, l * (1 - amount));
  const [nr, ng, nb] = hslToRgb(h, s, nl);
  return rgbToHex(nr, ng, nb);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const LIGHT_NEUTRALS: Omit<ThemeTokens, "bg" | "primary" | "secondary" | "accent" | "chart"> = {
  fg: "#0f172a",
  surface: "#ffffff",
  muted: "#475569",
  border: "#e2e8f0",
  ring: "#c2410c", // placeholder — ghi đè bằng primary bên dưới
  tooltip: "#ffffff",
  onPrimary: "#ffffff",
};

const DARK_NEUTRALS: Omit<ThemeTokens, "primary" | "secondary" | "accent" | "chart"> = {
  bg: "#0b1220",
  fg: "#e2e8f0",
  surface: "#0f172a",
  muted: "#94a3b8",
  border: "#1e293b",
  ring: "#818cf8", // placeholder — ghi đè bằng primary dark bên dưới
  tooltip: "#1e293b",
  onPrimary: "#0f172a",
};

function deriveDark(light: ThemeTokens): ThemeTokens {
  return {
    ...DARK_NEUTRALS,
    primary: lighten(light.primary, 0.5),
    secondary: lighten(light.secondary, 0.5),
    accent: lighten(light.accent, 0.45),
    ring: lighten(light.primary, 0.5),
    chart: light.chart.map((c) => lighten(c, 0.45)),
  };
}

function defineTheme(
  id: string,
  name: string,
  bg: string,
  primary: string,
  secondary: string,
  accent: string,
  chart: string[]
): ThemeDef {
  const light: ThemeTokens = { ...LIGHT_NEUTRALS, bg, primary, secondary, accent, ring: primary, chart };
  return { id, name, light, dark: deriveDark(light) };
}

export const THEMES: ThemeDef[] = [
  defineTheme("hr-partner", "HR Partner", "#FFF5EC", "#C2410C", "#7C2D12", "#EA580C", [
    "#C2410C", "#EA580C", "#D97706", "#9A3412", "#059669", "#0369A1", "#7C3AED", "#475569",
  ]),
  defineTheme("royal-navy", "Royal Navy", "#EEF2FB", "#0738CD", "#042280", "#FF0065", [
    "#3745A5", "#0738CD", "#EA580C", "#E11D48", "#059669", "#7C3AED", "#CA8A04", "#475569",
  ]),
  defineTheme("ocean-trust", "Ocean Trust", "#EFF8FF", "#075985", "#0E7490", "#0F766E", [
    "#0369A1", "#0891B2", "#0F766E", "#2563EB", "#65A30D", "#9333EA", "#D97706", "#475569",
  ]),
  defineTheme("emerald-growth", "Emerald Growth", "#EFFAF5", "#047857", "#0F766E", "#1D4ED8", [
    "#059669", "#0D9488", "#2563EB", "#65A30D", "#7C3AED", "#CA8A04", "#DC2626", "#475569",
  ]),
  defineTheme("violet-future", "Violet Future", "#F5F2FF", "#6D28D9", "#4F46E5", "#BE185D", [
    "#7C3AED", "#4F46E5", "#C026D3", "#DB2777", "#0891B2", "#059669", "#D97706", "#475569",
  ]),
  defineTheme("executive-gold", "Executive Gold", "#F1F5F9", "#0F172A", "#334155", "#B45309", [
    "#1E3A8A", "#0F766E", "#B45309", "#7C3AED", "#BE123C", "#0369A1", "#4D7C0F", "#64748B",
  ]),
];

export const DEFAULT_THEME_ID = "hr-partner";
export const THEME_STORAGE_KEY = "mini-bi-theme";

export function isValidThemeId(id: string | null | undefined): id is string {
  return typeof id === "string" && THEMES.some((t) => t.id === id);
}

/** Trả theme theo id; id sai/thiếu fallback về default. */
export function getTheme(id: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Chuẩn hóa giá trị persist thô (localStorage) — sai/null => default. */
export function resolveThemeId(raw: string | null | undefined): string {
  return isValidThemeId(raw) ? (raw as string) : DEFAULT_THEME_ID;
}

// ---------------------------------------------------------------------------
// Semantic colors cố định (độc lập theme) — emerald/amber/rose/sky/slate.
// ---------------------------------------------------------------------------

export type SemanticKey = "success" | "warning" | "error" | "running" | "slate";

export const SEMANTIC_COLORS: Record<SemanticKey, Record<ColorMode, string>> = {
  success: { light: "#047857", dark: "#34d399" }, // emerald
  warning: { light: "#b45309", dark: "#fbbf24" }, // amber (unknown / partial)
  error: { light: "#be123c", dark: "#fb7185" }, // rose (invalid / failed)
  running: { light: "#0369a1", dark: "#38bdf8" }, // sky
  slate: { light: "#64748b", dark: "#94a3b8" }, // slate (no-run / "Khác")
};

// ---------------------------------------------------------------------------
// Color slot (chart category + semantic status) — do chart-data trả về.
// ---------------------------------------------------------------------------

export type ChartSlot = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6" | "chart-7" | "chart-8";
export type ColorSlot = ChartSlot | SemanticKey;

export const CHART_SLOT_COUNT = 8;

function isSemantic(slot: ColorSlot): slot is SemanticKey {
  return slot === "success" || slot === "warning" || slot === "error" || slot === "running" || slot === "slate";
}

/** Resolve slot -> hex theo theme + mode. */
export function resolveColor(slot: ColorSlot, theme: ThemeDef, mode: ColorMode): string {
  if (isSemantic(slot)) return SEMANTIC_COLORS[slot][mode];
  const n = Number(slot.slice("chart-".length));
  return (mode === "dark" ? theme.dark.chart : theme.light.chart)[n - 1];
}

/** Slot -> CSS var string (cho inline style của element không phải recharts). */
export function slotToCssVar(slot: ColorSlot): string {
  if (slot === "success") return "var(--semantic-success)";
  if (slot === "warning") return "var(--semantic-warning)";
  if (slot === "error") return "var(--semantic-error)";
  if (slot === "running") return "var(--semantic-running)";
  if (slot === "slate") return "var(--semantic-slate)";
  return "var(--" + slot + ")";
}

/** Slot chart -> index 0..7 (để resolve adjacency trong project donut). */
export function chartSlotIndex(slot: ColorSlot): number {
  return Number(slot.slice("chart-".length)) - 1;
}

export function isChartSlot(slot: ColorSlot): slot is ChartSlot {
  return !isSemantic(slot);
}

// ---------------------------------------------------------------------------
// CSS custom property bridge (theme -> các biến semantic dùng ở UI/chart).
// ---------------------------------------------------------------------------

export interface CssVars {
  [name: string]: string;
}

/** Token active (theme × mode) -> CSS custom properties (không gồm --semantic-*). */
export function themeTokensToCssVars(theme: ThemeDef, mode: ColorMode): CssVars {
  const t = mode === "dark" ? theme.dark : theme.light;
  const vars: CssVars = {
    "--background": t.bg,
    "--foreground": t.fg,
    "--surface": t.surface,
    "--muted": t.muted,
    "--border": t.border,
    "--primary": t.primary,
    "--secondary": t.secondary,
    "--accent": t.accent,
    "--ring": t.ring,
    "--tooltip": t.tooltip,
    "--on-primary": t.onPrimary,
  };
  for (let i = 0; i < t.chart.length; i++) vars["--chart-" + (i + 1)] = t.chart[i];
  return vars;
}

/** Toàn bộ CSS vars (theme + semantic) cho một (theme, mode). */
export function tokensToCssVars(theme: ThemeDef, mode: ColorMode): CssVars {
  const vars = themeTokensToCssVars(theme, mode);
  for (const key of Object.keys(SEMANTIC_COLORS) as SemanticKey[]) {
    vars["--semantic-" + key] = SEMANTIC_COLORS[key][mode];
  }
  return vars;
}

/**
 * Inline script chạy TRƯỚC paint (đặt trong <head>) để áp theme + mode mà
 * không flash theme mặc định và không gây hydration mismatch.
 * Sinh ra từ registry (single source of truth), không chứa credential.
 */
export function buildThemeInitScript(): string {
  const themesJson = JSON.stringify(THEMES);
  const semanticJson = JSON.stringify(SEMANTIC_COLORS);
  const key = THEME_STORAGE_KEY;
  const defaultId = DEFAULT_THEME_ID;
  return `(function(){try{var t=${themesJson},sem=${semanticJson},key="${key}",def="${defaultId}";var id=null;try{id=localStorage.getItem(key);}catch(e){}var ok=false;for(var i=0;i<t.length;i++){if(t[i].id===id){ok=true;break;}}if(!ok){id=def;}var dark=false;try{dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;}catch(e){}var m=dark?"dark":"light";var th=t[0];for(var j=0;j<t.length;j++){if(t[j].id===id){th=t[j];break;}}var tk=m==="dark"?th.dark:th.light;var el=document.documentElement;el.setAttribute("data-theme",id);el.style.colorScheme=m;var vars={"--background":tk.bg,"--foreground":tk.fg,"--surface":tk.surface,"--muted":tk.muted,"--border":tk.border,"--primary":tk.primary,"--secondary":tk.secondary,"--accent":tk.accent,"--ring":tk.ring,"--tooltip":tk.tooltip,"--on-primary":tk.onPrimary};for(var c=0;c<tk.chart.length;c++){vars["--chart-"+(c+1)]=tk.chart[c];}var ks=Object.keys(sem);for(var s=0;s<ks.length;s++){vars["--semantic-"+ks[s]]=sem[ks[s]][m];}var names=Object.keys(vars);for(var v=0;v<names.length;v++){el.style.setProperty(names[v],vars[names[v]]);}}catch(e){}})();`;
}
