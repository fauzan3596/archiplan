// RAB lines and the Indonesian rekapitulasi: subtotals -> Jumlah Harga
// Pekerjaan -> Jasa Kontraktor % -> PPN 11 % (optional, PMK 131/2024) ->
// Total -> Pembulatan ke atas Rp 10.000 -> Terbilang. Layout convention:
// https://ukirama.com/blogs/rab-rencana-anggaran-biaya-panduan-lengkap-contoh-dan-tips-membuatnya ;
// https://www.beginisob.com/2025/12/cara-membuat-rab-bangunan-di-excel.html

import { gateForRabExport } from "../plan/validate";
import { planWallMaterial } from "../plan/materials";
import {
  BANGUN_BARU_ITEM,
  BENCHMARK_LABELS,
  DEMOLITION_ITEM_IDS,
  FLOOR_TOKEN,
  GRADE_ORDER,
  GROUP_LABELS,
  GROUP_ORDER,
  PAKET,
  PER_M2_BENCHMARKS,
  PPN_PCT,
  RAB_ITEMS,
  RAB_PRICE_VERSION,
  REGION_MULTIPLIERS,
  ROUND_TO,
  type RabGroup,
  type RabItem,
  type RabUnit,
} from "./data";
import { computeQuantities, LUAS_MISMATCH_PCT, type Quantities } from "./geometry";

export interface RabLine {
  /** number within its kelompok ("1", "2", ...) */
  no: string;
  item: RabItem;
  /** volume before waste / override (display in the waste tooltip) */
  baseVolume: number;
  /** final volume (waste applied, or the override) */
  volume: number;
  satuan: RabUnit;
  hargaSatuan: number;
  /** volume × hargaSatuan, rounded to Rupiah; counted only when enabled */
  jumlah: number;
  estimate: boolean;
  /** waste percentage included in `volume` (0 when the volume is overridden) */
  wastePct: number;
  /** any of volume / harga / enabled overridden */
  overridden: boolean;
  volumeOverridden: boolean;
  hargaOverridden: boolean;
  enabled: boolean;
  /** the per-unit minimum (jendela) raised hargaSatuan */
  minApplied: boolean;
}

export interface RabGroupBlock {
  group: RabGroup;
  /** roman numeral assigned in rekap order */
  roman: string;
  label: string;
  lines: RabLine[];
  /** Σ jumlah of enabled lines */
  subtotal: number;
}

export interface RabBenchmark {
  /** benchmark rate × region factor × perM2Basis */
  low: number;
  mid: number;
  high: number;
  /** Σ floor area used as the per-m² basis */
  perM2Basis: number;
  /** per-m² rates after the region factor */
  rateLow: number;
  rateMid: number;
  rateHigh: number;
  label: string;
}

export interface Rekap {
  groups: RabGroupBlock[];
  jumlahPekerjaan: number;
  contractorFeePct: number;
  jasaKontraktor: number;
  /** Jumlah + jasa kontraktor (the base the 11 % effective PPN is applied to) */
  dpp: number;
  ppnPct: number;
  includePpn: boolean;
  ppn: number;
  total: number;
  pembulatan: number;
  totalBulat: number;
  terbilang: string;
  benchmark: RabBenchmark;
  gradeTotals: Record<RabGrade, number>;
  regionFactor: number;
  priceVersion: string;
  quantities: Quantities;
  /** luasMismatchPct > LUAS_MISMATCH_PCT */
  luasMismatch: boolean;
  exportGate: { ok: boolean; reasons: PlanIssue[] };
  /** informative notes shown under the table (e.g. unpainted brick walls) */
  notes: string[];
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const round2 = (n: number): number => Math.round(n * 100) / 100;

const positive = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Items of a paket in RAB_ITEMS order; "@floor" expands to every floor
 *  material item present in the plan; demolition items only when enabled. */
export const expandPaketItems = (
  paket: RabPaket,
  q: Quantities,
  demolition: boolean,
): RabItem[] => {
  const wanted = new Set<string>();
  for (const id of PAKET[paket].items) {
    if (id === FLOOR_TOKEN) {
      for (const [itemId, area] of Object.entries(q.floorAreaByItem)) {
        if (area > 0) wanted.add(itemId);
      }
      continue;
    }
    wanted.add(id);
  }
  if (!demolition) {
    for (const id of DEMOLITION_ITEM_IDS) wanted.delete(id);
  }
  return RAB_ITEMS.filter((item) => wanted.has(item.id));
};

const baseVolumeFor = (item: RabItem, q: Quantities): number => {
  if (item.basis === "floor_material_area") return q.floorAreaByItem[item.id] ?? 0;
  if (item.basis === "wall_material_area") return q.wallAreaByItem[item.id] ?? 0;
  return q[item.basis];
};

const buildLine = (
  item: RabItem,
  q: Quantities,
  inputs: RabInputs,
  grade: RabGrade,
  factor: number,
): Omit<RabLine, "no"> | null => {
  const ov = inputs.overrides?.[item.id] ?? {};
  const volumeOverride = positive(ov.volume);
  const hargaOverride = positive(ov.harga);
  const enabled = ov.enabled !== false;

  const baseVolume = round2(baseVolumeFor(item, q));
  const volume = volumeOverride ?? round2(baseVolume * (1 + item.waste));
  if (volume <= 0 && volumeOverride === null) return null;

  // Override harga is the final (displayed) harga satuan: no region factor.
  let hargaSatuan = hargaOverride ?? Math.round(item.harga[grade] * factor);
  let minApplied = false;
  if (item.minPerUnit && volumeOverride === null && hargaOverride === null && volume > 0) {
    const count = q[item.minPerUnitCount ?? "window_count"];
    const minTotal = Math.round(item.minPerUnit * factor) * count;
    if (count > 0 && volume * hargaSatuan < minTotal) {
      hargaSatuan = Math.ceil(minTotal / volume);
      minApplied = true;
    }
  }

  return {
    item,
    baseVolume,
    volume,
    satuan: item.satuan,
    hargaSatuan,
    jumlah: Math.round(volume * hargaSatuan),
    estimate: item.estimate === true,
    wastePct: volumeOverride === null ? Math.round(item.waste * 100) : 0,
    overridden: volumeOverride !== null || hargaOverride !== null || !enabled,
    volumeOverridden: volumeOverride !== null,
    hargaOverridden: hargaOverride !== null,
    enabled,
    minApplied,
  };
};

const buildGroups = (
  q: Quantities,
  inputs: RabInputs,
  grade: RabGrade,
  factor: number,
): RabGroupBlock[] => {
  const byGroup = new Map<RabGroup, Omit<RabLine, "no">[]>();

  if (inputs.paket === "bangun_baru") {
    const line = buildLine(BANGUN_BARU_ITEM, q, inputs, grade, factor);
    if (line) byGroup.set(BANGUN_BARU_ITEM.group, [line]);
  } else {
    for (const item of expandPaketItems(inputs.paket, q, inputs.demolition)) {
      const line = buildLine(item, q, inputs, grade, factor);
      if (!line) continue;
      const list = byGroup.get(item.group) ?? [];
      list.push(line);
      byGroup.set(item.group, list);
    }
  }

  const blocks: RabGroupBlock[] = [];
  for (const group of GROUP_ORDER) {
    const lines = byGroup.get(group);
    if (!lines || lines.length === 0) continue;
    blocks.push({
      group,
      roman: ROMAN[blocks.length] ?? String(blocks.length + 1),
      label: GROUP_LABELS[group],
      lines: lines.map((line, i) => ({ ...line, no: String(i + 1) })),
      subtotal: lines.reduce((sum, l) => sum + (l.enabled ? l.jumlah : 0), 0),
    });
  }
  return blocks;
};

interface RekapTotals {
  jumlahPekerjaan: number;
  jasaKontraktor: number;
  dpp: number;
  ppn: number;
  total: number;
  totalBulat: number;
}

const totalsFor = (groups: RabGroupBlock[], inputs: RabInputs): RekapTotals => {
  const feePct = clampFee(inputs.contractorFeePct);
  const jumlahPekerjaan = groups.reduce((sum, g) => sum + g.subtotal, 0);
  const jasaKontraktor = Math.round(jumlahPekerjaan * (feePct / 100));
  const dpp = jumlahPekerjaan + jasaKontraktor;
  const ppn = inputs.includePpn ? Math.round(dpp * (PPN_PCT / 100)) : 0;
  const total = dpp + ppn;
  const totalBulat = Math.ceil(total / ROUND_TO) * ROUND_TO;
  return { jumlahPekerjaan, jasaKontraktor, dpp, ppn, total, totalBulat };
};

const clampFee = (pct: number): number =>
  Number.isFinite(pct) ? Math.min(15, Math.max(0, pct)) : 0;

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const computeRab = (plan: FloorPlan, inputs: RabInputs): Rekap => {
  const q = computeQuantities(plan, inputs);
  const factor = REGION_MULTIPLIERS[inputs.region]?.factor ?? 1;

  const groups = buildGroups(q, inputs, inputs.grade, factor);
  const totals = totalsFor(groups, inputs);

  const gradeTotals = {} as Record<RabGrade, number>;
  for (const grade of GRADE_ORDER) {
    gradeTotals[grade] =
      grade === inputs.grade
        ? totals.totalBulat
        : totalsFor(buildGroups(q, inputs, grade, factor), inputs).totalBulat;
  }

  const benchmarkKey = PAKET[inputs.paket].benchmark;
  const rates = PER_M2_BENCHMARKS[benchmarkKey];
  const rateLow = Math.round(rates.low * factor);
  const rateMid = Math.round(rates.mid * factor);
  const rateHigh = Math.round(rates.high * factor);

  const notes: string[] = [];
  const wallMaterial = planWallMaterial(plan);
  if (
    inputs.paket !== "bangun_baru" &&
    PAKET[inputs.paket].items.includes("cat_interior") &&
    wallMaterial.rabItemId === null
  ) {
    notes.push(`Dinding ${wallMaterial.name.toLowerCase()}: cat dinding interior tidak dihitung.`);
  }
  if (q.perRoom.length === 0) {
    notes.push("Belum ada ruangan: volume lantai, plafon dan titik listrik bernilai nol.");
  }
  if (plan.rooms.some((r) => r.stale)) {
    notes.push("Ruangan terputus tidak dihitung. Bangun ulang ruangan di tab Denah 2D.");
  }

  return {
    groups,
    jumlahPekerjaan: totals.jumlahPekerjaan,
    contractorFeePct: clampFee(inputs.contractorFeePct),
    jasaKontraktor: totals.jasaKontraktor,
    dpp: totals.dpp,
    ppnPct: PPN_PCT,
    includePpn: inputs.includePpn,
    ppn: totals.ppn,
    total: totals.total,
    pembulatan: totals.totalBulat - totals.total,
    totalBulat: totals.totalBulat,
    terbilang: `${capitalize(terbilang(totals.totalBulat))} rupiah`,
    benchmark: {
      low: Math.round(rateLow * q.floor_area),
      mid: Math.round(rateMid * q.floor_area),
      high: Math.round(rateHigh * q.floor_area),
      perM2Basis: q.floor_area,
      rateLow,
      rateMid,
      rateHigh,
      label: BENCHMARK_LABELS[benchmarkKey],
    },
    gradeTotals,
    regionFactor: factor,
    priceVersion: RAB_PRICE_VERSION,
    quantities: q,
    luasMismatch: q.luasMismatchPct !== null && q.luasMismatchPct > LUAS_MISMATCH_PCT,
    exportGate: gateForRabExport(plan),
    notes,
  };
};

// --- formatting ---------------------------------------------------------------

const idrFormat = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const volumeFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatIDR = (n: number): string => idrFormat.format(n);

export const formatVolume = (n: number): string => volumeFormat.format(n);

// Terbilang (Indonesian number words) — conventional last row of a RAB rekap.
const SATUAN = [
  "",
  "satu",
  "dua",
  "tiga",
  "empat",
  "lima",
  "enam",
  "tujuh",
  "delapan",
  "sembilan",
  "sepuluh",
  "sebelas",
];

const words = (n: number): string => {
  if (n < 12) return SATUAN[n];
  if (n < 20) return `${words(n - 10)} belas`;
  if (n < 100) return `${words(Math.floor(n / 10))} puluh ${words(n % 10)}`.trim();
  if (n < 200) return `seratus ${words(n - 100)}`.trim();
  if (n < 1000) return `${words(Math.floor(n / 100))} ratus ${words(n % 100)}`.trim();
  if (n < 2000) return `seribu ${words(n - 1000)}`.trim();
  if (n < 1_000_000) return `${words(Math.floor(n / 1000))} ribu ${words(n % 1000)}`.trim();
  if (n < 1_000_000_000) {
    return `${words(Math.floor(n / 1_000_000))} juta ${words(n % 1_000_000)}`.trim();
  }
  if (n < 1_000_000_000_000) {
    return `${words(Math.floor(n / 1_000_000_000))} miliar ${words(n % 1_000_000_000)}`.trim();
  }
  return `${words(Math.floor(n / 1_000_000_000_000))} triliun ${words(n % 1_000_000_000_000)}`.trim();
};

/** 1_234_567 -> "satu juta dua ratus tiga puluh empat ribu lima ratus enam puluh tujuh". */
export const terbilang = (n: number): string => {
  const v = Math.floor(Math.abs(Number.isFinite(n) ? n : 0));
  if (v === 0) return "nol";
  return `${n < 0 ? "minus " : ""}${words(v)}`;
};

export const RAB_DISCLAIMERS: readonly string[] = [
  "Estimasi awal (indikatif), bukan penawaran harga / quotation dan bukan dokumen kontrak.",
  `Harga satuan mengacu harga pasar publik 2025–2026 dengan dasar Jabodetabek (versi tabel ${RAB_PRICE_VERSION}), dikalikan faktor wilayah dari Indeks Kemahalan Konstruksi BPS 2025; harga aktual bervariasi menurut lokasi, merek, kualitas material, kondisi lapangan, waktu, dan negosiasi dengan tukang/kontraktor.`,
  "Volume dihitung dari denah (hasil AI atau gambar manual) dan tinggi dinding pada denah; verifikasi ukuran di lapangan sebelum digunakan. Item bertanda \"estimasi\" belum memiliki sumber harga bertanggal.",
  "Belum termasuk: pekerjaan struktur/pondasi, atap, sanitair & plumbing, kitchen set, furnitur, AC, perizinan (PBG), mobilisasi, dan biaya tak terduga.",
  "PPN 11% hanya berlaku bila kontraktor berstatus PKP (PMK 131/2024: 12% × DPP 11/12). Jasa kontraktor adalah asumsi umum (praktik 10–15%).",
  "Disarankan menyiapkan dana cadangan 10–15% dari total estimasi.",
];
