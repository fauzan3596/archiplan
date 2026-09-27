import { describe, expect, it } from "vitest";
import { SAMPLE_PLAN } from "../plan/fixtures/sample-plan";
import { TWO_ROOM_PLAN } from "../plan/fixtures/two-room-plan";
import { DEFAULT_RAB_INPUTS } from "../plan/defaults";
import { FLOOR_MATERIALS } from "../plan/materials";
import { computeRab, formatIDR, formatVolume, terbilang, type RabLine, type Rekap } from "./compute";
import { rabCsvFilename, rabToCsv } from "./csv";
import { PAKET, RAB_ITEM_BY_ID, RAB_ITEMS, REGION_MULTIPLIERS } from "./data";

const inputs = (patch: Partial<RabInputs> = {}): RabInputs => ({
  ...DEFAULT_RAB_INPUTS,
  overrides: {},
  ...patch,
});

const lineOf = (rekap: Rekap, id: string): RabLine | undefined =>
  rekap.groups.flatMap((g) => g.lines).find((l) => l.item.id === id);

const REQUIRED_IDS = [
  "lantai_keramik_40",
  "lantai_granit_60",
  "lantai_parket",
  "lantai_vinyl",
  "cat_interior",
  "plint_keramik",
  "plafon_gypsum",
  "cat_plafon",
  "plester_aci",
  "pintu_kamar_kayu",
  "pintu_km_pvc",
  "pintu_utama",
  "jendela_alu",
  "titik_lampu",
  "titik_stopkontak",
  "cat_eksterior",
  "bongkar_lantai",
  "bongkar_plafon",
  "buang_puing",
];

/** Minimal quote-aware splitter for one CSV line. */
const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
};

describe("price data", () => {
  it("has exactly the agreed item ids, all with sources and monotone grades", () => {
    expect(RAB_ITEMS.map((i) => i.id).sort()).toEqual([...REQUIRED_IDS].sort());
    for (const item of RAB_ITEMS) {
      expect(item.sources.length).toBeGreaterThan(0);
      expect(item.harga.low).toBeLessThanOrEqual(item.harga.mid);
      expect(item.harga.mid).toBeLessThanOrEqual(item.harga.high);
    }
  });

  it("covers every floor material's rabItemId", () => {
    for (const m of FLOOR_MATERIALS) {
      if (m.rabItemId) expect(RAB_ITEM_BY_ID[m.rabItemId]).toBeDefined();
    }
  });

  it("references only known items (or the @floor token) in every paket", () => {
    for (const paket of Object.values(PAKET)) {
      for (const id of paket.items) {
        if (id !== "@floor") expect(RAB_ITEM_BY_ID[id]).toBeDefined();
      }
    }
  });
});

describe("computeRab — rekap arithmetic", () => {
  const rekap = computeRab(
    SAMPLE_PLAN,
    inputs({ paket: "ringan", grade: "mid", region: "jabodetabek", contractorFeePct: 10, includePpn: true }),
  );

  it("follows jumlah -> jasa kontraktor -> PPN 11 % -> total -> pembulatan Rp 10.000", () => {
    const lines = rekap.groups.flatMap((g) => g.lines);
    for (const g of rekap.groups) {
      expect(g.subtotal).toBe(g.lines.reduce((s, l) => s + (l.enabled ? l.jumlah : 0), 0));
    }
    for (const l of lines) expect(l.jumlah).toBe(Math.round(l.volume * l.hargaSatuan));
    const jumlah = rekap.groups.reduce((s, g) => s + g.subtotal, 0);
    expect(rekap.jumlahPekerjaan).toBe(jumlah);
    expect(rekap.jasaKontraktor).toBe(Math.round(jumlah * 0.1));
    expect(rekap.dpp).toBe(jumlah + rekap.jasaKontraktor);
    expect(rekap.ppn).toBe(Math.round(rekap.dpp * 0.11));
    expect(rekap.total).toBe(rekap.dpp + rekap.ppn);
    expect(rekap.totalBulat % 10_000).toBe(0);
    expect(rekap.totalBulat).toBeGreaterThanOrEqual(rekap.total);
    expect(rekap.pembulatan).toBe(rekap.totalBulat - rekap.total);
    expect(rekap.pembulatan).toBeLessThan(10_000);
    expect(rekap.terbilang.endsWith(" rupiah")).toBe(true);
    expect(rekap.terbilang[0]).toBe(rekap.terbilang[0].toUpperCase());
    expect(rekap.priceVersion).toBe("2026-09");
    expect(rekap.exportGate.ok).toBe(true);
  });

  it("omits PPN when the toggle is off", () => {
    const noPpn = computeRab(SAMPLE_PLAN, inputs({ includePpn: false }));
    expect(noPpn.ppn).toBe(0);
    expect(noPpn.total).toBe(noPpn.dpp);
  });

  it("applies waste to material-driven volumes", () => {
    const keramik = lineOf(rekap, "lantai_keramik_40");
    expect(keramik?.baseVolume).toBe(59);
    expect(keramik?.volume).toBe(63.13); // 59 x 1.07
    expect(keramik?.hargaSatuan).toBe(160_000);
    expect(keramik?.jumlah).toBe(10_100_800);
    expect(keramik?.wastePct).toBe(7);
  });

  it("expands @floor into one line per floor material present", () => {
    const lantai = rekap.groups.find((g) => g.group === "lantai");
    expect(lantai?.lines.map((l) => l.item.id)).toEqual([
      "lantai_keramik_40",
      "lantai_granit_60",
      "plint_keramik",
    ]);
    expect(lineOf(rekap, "lantai_granit_60")?.volume).toBe(22.47); // 21 x 1.07

    const single = computeRab(TWO_ROOM_PLAN, inputs());
    const floorIds = single.groups
      .flatMap((g) => g.lines)
      .map((l) => l.item.id)
      .filter((id) => id.startsWith("lantai_"));
    expect(floorIds).toEqual(["lantai_keramik_40"]);

    const vinyl = structuredClone(TWO_ROOM_PLAN);
    vinyl.rooms[1] = { ...vinyl.rooms[1], floorMaterialId: "vinyl_oak" };
    const mixed = computeRab(vinyl, inputs());
    expect(lineOf(mixed, "lantai_vinyl")?.baseVolume).toBe(40);
    expect(lineOf(mixed, "lantai_keramik_40")?.baseVolume).toBe(40);
  });

  it("numbers groups with roman numerals and hides demolition unless enabled", () => {
    expect(rekap.groups.map((g) => g.roman)).toEqual(
      rekap.groups.map((_, i) => ["I", "II", "III", "IV", "V", "VI", "VII"][i]),
    );
    expect(rekap.groups.some((g) => g.group === "persiapan")).toBe(false);
    const demo = computeRab(SAMPLE_PLAN, inputs({ demolition: true }));
    const persiapan = demo.groups[0];
    expect(persiapan.group).toBe("persiapan");
    expect(persiapan.roman).toBe("I");
    expect(persiapan.lines.map((l) => l.item.id)).toEqual([
      "bongkar_lantai",
      "bongkar_plafon",
      "buang_puing",
    ]);
  });

  it("zeroes the cat_interior line for bata ekspos walls", () => {
    const brick = structuredClone(SAMPLE_PLAN);
    brick.materials = { ...brick.materials, wall: "bata_ekspos" };
    const r = computeRab(brick, inputs());
    expect(lineOf(r, "cat_interior")).toBeUndefined();
    expect(lineOf(rekap, "cat_interior")?.volume).toBeGreaterThan(0);
    expect(r.notes.join(" ")).toMatch(/bata ekspos/);
  });
});

describe("computeRab — windows, grades, regions, overrides, paket", () => {
  it("floors small windows at the per-unit minimum", () => {
    const plan = structuredClone(TWO_ROOM_PLAN);
    // one 0.5 x 0.5 m window (0.25 m²) on wN: 0.25 x Rp1.2jt = Rp300rb < Rp600rb/unit
    plan.openings = [
      { id: "tiny", wallId: "wN", kind: "window", t0: 0.19, t1: 0.24, bottom: 1.6, top: 2.1 },
    ];
    const r = computeRab(plan, inputs({ paket: "sedang" }));
    const jendela = lineOf(r, "jendela_alu");
    expect(jendela?.volume).toBeCloseTo(0.25, 9);
    expect(jendela?.minApplied).toBe(true);
    expect(jendela?.jumlah).toBe(600_000);
    expect(jendela?.hargaSatuan).toBe(2_400_000);

    // a normal window stays per m²
    const big = computeRab(TWO_ROOM_PLAN, inputs({ paket: "sedang" }));
    const normal = lineOf(big, "jendela_alu");
    expect(normal?.minApplied).toBe(false);
    expect(normal?.hargaSatuan).toBe(1_200_000);
    expect(normal?.jumlah).toBe(Math.round(7.2 * 1_200_000));
  });

  it("orders grade totals Ekonomis <= Standar <= Premium and reuses the active grade", () => {
    for (const paket of ["ringan", "sedang", "bangun_baru"] as const) {
      const r = computeRab(SAMPLE_PLAN, inputs({ paket, grade: "high", includePpn: true }));
      expect(r.gradeTotals.low).toBeLessThanOrEqual(r.gradeTotals.mid);
      expect(r.gradeTotals.mid).toBeLessThanOrEqual(r.gradeTotals.high);
      expect(r.gradeTotals.high).toBe(r.totalBulat);
    }
  });

  it("scales catalogue prices by the region factor", () => {
    const base = computeRab(SAMPLE_PLAN, inputs({ region: "jabodetabek" }));
    const jateng = computeRab(SAMPLE_PLAN, inputs({ region: "jateng" }));
    expect(jateng.regionFactor).toBe(REGION_MULTIPLIERS.jateng.factor);
    expect(jateng.regionFactor).toBe(0.88);
    expect(lineOf(jateng, "lantai_keramik_40")?.hargaSatuan).toBe(Math.round(160_000 * 0.88));
    expect(jateng.jumlahPekerjaan).toBeLessThan(base.jumlahPekerjaan);
    expect(jateng.benchmark.rateMid).toBe(Math.round(800_000 * 0.88));
  });

  it("applies per-line volume / harga / enabled overrides", () => {
    const base = computeRab(SAMPLE_PLAN, inputs());
    const keramik = lineOf(base, "lantai_keramik_40");
    expect(keramik).toBeDefined();

    const r = computeRab(
      SAMPLE_PLAN,
      inputs({
        overrides: {
          lantai_keramik_40: { volume: 50, harga: 100_000 },
          cat_plafon: { enabled: false },
          plafon_gypsum: { volume: null, harga: null, enabled: null },
        },
      }),
    );
    const k = lineOf(r, "lantai_keramik_40");
    expect(k?.volume).toBe(50);
    expect(k?.hargaSatuan).toBe(100_000);
    expect(k?.jumlah).toBe(5_000_000);
    expect(k?.wastePct).toBe(0);
    expect(k?.overridden).toBe(true);

    const catPlafon = lineOf(r, "cat_plafon");
    expect(catPlafon?.enabled).toBe(false);
    const pengecatan = r.groups.find((g) => g.group === "pengecatan");
    expect(pengecatan?.subtotal).toBe(lineOf(r, "cat_interior")?.jumlah);

    expect(lineOf(r, "plafon_gypsum")?.overridden).toBe(false);
    expect(r.jumlahPekerjaan).toBe(
      base.jumlahPekerjaan -
        (keramik?.jumlah ?? 0) +
        5_000_000 -
        (lineOf(base, "cat_plafon")?.jumlah ?? 0),
    );
  });

  it("prices bangun_baru as a single per-m² line with the benchmark range", () => {
    const r = computeRab(SAMPLE_PLAN, inputs({ paket: "bangun_baru", region: "jatim" }));
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].lines).toHaveLength(1);
    const line = r.groups[0].lines[0];
    expect(line.volume).toBe(80);
    expect(line.hargaSatuan).toBe(Math.round(5_000_000 * 0.85));
    expect(r.benchmark.perM2Basis).toBeCloseTo(80, 9);
    expect(r.benchmark.low).toBe(Math.round(3_500_000 * 0.85) * 80);
    expect(r.benchmark.high).toBe(Math.round(8_000_000 * 0.85) * 80);
  });

  it("flags LUAS_MISMATCH above 15 % and gates export", () => {
    expect(computeRab(SAMPLE_PLAN, inputs({ luasBangunanM2: 100 })).luasMismatch).toBe(true);
    expect(computeRab(SAMPLE_PLAN, inputs({ luasBangunanM2: 85 })).luasMismatch).toBe(false);

    const unconfirmed = structuredClone(SAMPLE_PLAN);
    unconfirmed.scale = { ...unconfirmed.scale, confirmed: false };
    const r = computeRab(unconfirmed, inputs());
    expect(r.exportGate.ok).toBe(false);
    expect(r.exportGate.reasons.map((x) => x.code)).toContain("SCALE_UNCONFIRMED");
    expect(r.totalBulat).toBeGreaterThan(0);
  });
});

describe("formatting", () => {
  it("spells terbilang in Indonesian", () => {
    expect(terbilang(1_234_567)).toBe(
      "satu juta dua ratus tiga puluh empat ribu lima ratus enam puluh tujuh",
    );
    expect(terbilang(0)).toBe("nol");
    expect(terbilang(11)).toBe("sebelas");
    expect(terbilang(1_000)).toBe("seribu");
    expect(terbilang(110_000)).toBe("seratus sepuluh ribu");
    expect(terbilang(2_000_050_000)).toBe("dua miliar lima puluh ribu");
  });

  it("formats IDR and volumes the id-ID way", () => {
    expect(formatIDR(1_234_567).replace(/\s/g, " ")).toBe("Rp 1.234.567");
    expect(formatVolume(63.125)).toMatch(/^63,1[23]$/);
    expect(formatVolume(1234.5)).toBe("1.234,50");
  });
});

describe("rabToCsv", () => {
  const plan = SAMPLE_PLAN;
  const inp = inputs({ paket: "sedang", includePpn: true, demolition: true });
  const rekap = computeRab(plan, inp);
  const csv = rabToCsv(rekap, plan, inp, "Rumah; \"Contoh\"");

  it("starts with a UTF-8 BOM and uses six ';' columns on every row", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) expect(splitCsvLine(line)).toHaveLength(6);
    expect(lines).toContain(
      "No;Uraian Pekerjaan;Volume;Satuan;Harga Satuan (Rp);Jumlah Harga (Rp)",
    );
  });

  it("contains group subtotals, the rekap rows, the grade range and disclaimers", () => {
    expect(csv).toContain("Sub Total Pekerjaan Lantai");
    expect(csv).toContain("REKAPITULASI");
    expect(csv).toContain(`TOTAL (dibulatkan);;;;${rekap.totalBulat}`);
    expect(csv).toContain("PPN 11% (PMK 131/2024)");
    expect(csv).toContain(`Terbilang: ${rekap.terbilang}`);
    expect(csv).toContain(`Ekonomis;;;;${rekap.gradeTotals.low}`);
    expect(csv).toContain(`Premium;;;;${rekap.gradeTotals.high}`);
    expect(csv).toContain("bukan penawaran harga");
    expect(csv).toContain("63,13;m²;160000;10100800");
    // the project name with ';' and '"' is quoted, not split
    expect(csv).toContain('"Proyek: Rumah; ""Contoh"""');
  });

  it("builds a safe filename", () => {
    expect(rabCsvFilename("Rumah Pak Budi!", "2026-09")).toBe("rab-rumah-pak-budi-2026-09.csv");
    expect(rabCsvFilename("", "2026-09")).toBe("rab-proyek-2026-09.csv");
  });
});
