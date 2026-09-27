// Sourced RAB price table (IDR). Harga satuan are ALL-IN (bahan + upah),
// baseline Jabodetabek / Jawa 2025–2026, in three grades (low = Ekonomis,
// mid = Standar, high = Premium). REGION_MULTIPLIERS scale them on top.
// `estimate: true` = no single dated source; derived from neighbouring figures.
// Every source URL from the research is kept in `sources` or as a comment.

export type RabUnit = "m2" | "m1" | "unit" | "titik" | "rit" | "ls";

export type RabGroup =
  | "persiapan"
  | "lantai"
  | "dinding"
  | "plafon"
  | "pintu_jendela"
  | "listrik"
  | "pengecatan"
  | "bangunan";

/** Numeric Quantities fields (lib/rab/geometry.ts) an item can be priced on. */
export type RabQuantityKey =
  | "floor_area" // Σ luas lantai ruangan (m2)
  | "ceiling_area" // = floor_area
  | "wall_interior_area" // sisi dalam, minus bukaan (m2)
  | "wall_exterior_area" // sisi luar, minus bukaan (m2)
  | "wall_both_area" // interior + exterior (plester/aci)
  | "plint_length" // Σ keliling ruangan − lebar pintu/bukaan lantai (m')
  | "door_room_count"
  | "door_bath_count"
  | "door_main_count"
  | "window_area"
  | "window_count"
  | "lamp_points"
  | "socket_points"
  | "demolition_floor_area"
  | "demolition_ceiling_area"
  | "debris_trips";

export type RabBasis =
  | RabQuantityKey
  /** Quantities.floorAreaByItem[item.id]: area of the rooms whose floor material maps to this item */
  | "floor_material_area"
  /** Quantities.wallAreaByItem[item.id]: interior wall area when the plan wall material maps to this item */
  | "wall_material_area";

export interface RabItem {
  id: string;
  group: RabGroup;
  uraian: string;
  satuan: RabUnit;
  basis: RabBasis;
  /** all-in harga satuan per grade (Jabodetabek baseline) */
  harga: Record<RabGrade, number>;
  /** optional split (display only) */
  upah?: Record<RabGrade, number>;
  bahan?: Record<RabGrade, number>;
  /** fraction added to the material-driven volume */
  waste: number;
  /** minimum jumlah per counted unit (jendela priced per m2 but floored per unit) */
  minPerUnit?: number;
  /** count used with minPerUnit (default window_count) */
  minPerUnitCount?: RabQuantityKey;
  estimate?: boolean;
  sources: string[];
}

export const RAB_PRICE_VERSION = "2026-09";

/** PMK 131/2024: 12 % × DPP 11/12 = 11 % effective for non-luxury services
 *  (https://www.pajak.go.id/en/node/113453 ;
 *  https://ortax.org/resmi-pmk-131-2024-atur-ppn-12-persen-hanya-untuk-barang-mewah). */
export const PPN_PCT = 11;

/** Pembulatan ke atas (Rp 10.000), the conventional last rekap step. */
export const ROUND_TO = 10_000;

/** Private contractors 10–12 %, up to 15 % (Perpres 16/2018 guidance caps
 *  keuntungan + overhead at 15 %):
 *  https://dimensiruangmegah.com/berapa-keuntungan-kontraktor-profesional/ ;
 *  https://www.duniakontraktor.com/2020/06/keuntungan-overhead-yang-wajar-15-persen.html */
export const CONTRACTOR_FEE_MAX_PCT = 15;

/** PAKET token expanded to one line per floor material present in the plan. */
export const FLOOR_TOKEN = "@floor";

export const RAB_ITEMS: readonly RabItem[] = [
  // ───────── I. PERSIAPAN & PEMBONGKARAN (only when inputs.demolition) ─────────
  {
    id: "bongkar_lantai",
    group: "persiapan",
    uraian: "Bongkar lantai keramik lama",
    satuan: "m2",
    basis: "demolition_floor_area",
    harga: { low: 30_000, mid: 50_000, high: 100_000 },
    waste: 0,
    sources: [
      "https://tokban.com/blog/biaya-pasang-keramik-per-meter/ (2026: Rp25–50rb/m2)",
      "https://realestat.id/harga-pasang-keramik-per-meter-2023-lengkap-dengan-jenis-bahan-dan-upah-bongkar/ (2025-04-16: Rp100rb/m2)",
      "https://archigalabangunpersada.com/harga-borongan-bongkar-keramik-lantai/ (2025-11-19 Jabodetabek: Rp150–250rb/m2)",
    ],
  },
  {
    id: "bongkar_plafon",
    group: "persiapan",
    uraian: "Bongkar plafon lama",
    satuan: "m2",
    basis: "demolition_ceiling_area",
    harga: { low: 15_000, mid: 25_000, high: 40_000 },
    waste: 0,
    estimate: true,
    sources: [
      "ESTIMASI — installers exclude removal from pasang price: https://pratamabaja.com/harga-borongan-pasang-plafon/ (2026-06)",
    ],
  },
  {
    id: "buang_puing",
    group: "persiapan",
    uraian: "Angkut & buang puing (truk engkel 6–7 m³)",
    satuan: "rit",
    basis: "debris_trips",
    harga: { low: 300_000, mid: 350_000, high: 450_000 },
    waste: 0,
    sources: [
      "https://jasabuangpuing.co.id/harga-jasa-buang-puing-per-rit/ (2025: engkel Rp300–350rb, dump Rp400–450rb per rit)",
      "https://www.brighton.co.id/about/articles-all/harga-borongan-bongkar-dinding-per-meter-yang-efisiensi (2023-12: Rp100–150rb/m3)",
    ],
  },

  // ───────── II. LANTAI ─────────
  {
    id: "lantai_keramik_40",
    group: "lantai",
    uraian: "Pasang lantai keramik 40x40 (bahan + upah)",
    satuan: "m2",
    basis: "floor_material_area",
    harga: { low: 115_000, mid: 160_000, high: 220_000 },
    upah: { low: 35_000, mid: 55_000, high: 75_000 },
    bahan: { low: 80_000, mid: 105_000, high: 145_000 },
    waste: 0.07,
    sources: [
      "https://tokban.com/blog/biaya-pasang-keramik-per-meter/ (2026: upah 40x40 Rp50–70rb; all-in Rp130–200rb/m2; waste 5–10%)",
      "https://www.realestat.id/berita-properti/daftar-harga-keramik-40x40-per-dus-berbagai-merek-terbaru-2025/ (2025-01-06: Rp40–80rb/dus, 6 pcs ≈0.96 m2)",
      "https://realestat.id/harga-pasang-keramik-per-meter-2023-lengkap-dengan-jenis-bahan-dan-upah-bongkar/ (2025-04-16: upah 40x40 Rp30–32rb)",
      "https://bimrab.id/koleksi/ahsp/15325 (AHSP 3.9.8.3 Jakarta Pusat: Rp216.976/m2 with premium tile)",
      "https://www.arsitur.com/2019/10/sni-73952008-pekerjaan-lantai-dinding.html (SNI 7395:2008 coefficients)",
      "https://tuwaga.id/artikel/cara-hitung-kebutuhan-keramik/ (waste lurus 5%, diagonal 12%)",
      "https://www.researchgate.net/publication/377949201_ANALISIS_NILAI_WASTE_KERAMIK_PADA_PROYEK_X (waste ≈9.5%)",
    ],
  },
  {
    id: "lantai_granit_60",
    group: "lantai",
    uraian: "Pasang lantai granit 60x60 (bahan + upah)",
    satuan: "m2",
    basis: "floor_material_area",
    harga: { low: 250_000, mid: 330_000, high: 450_000 },
    upah: { low: 70_000, mid: 95_000, high: 150_000 },
    bahan: { low: 140_000, mid: 200_000, high: 300_000 },
    waste: 0.07,
    sources: [
      "https://www.realestat.id/berita-properti/harga-borongan-pasang-granit-per-meter-persegi-terbaru-2025-lengkap-dengan-simulasi-biaya/ (2025-06-24: all-in Rp250–400rb; upah Rp90rb)",
      "https://www.qhomemart.com/blog/per-dus-harga-granit-60x60-termurah/ (2026-09: Rp121.500–334.800/dus, 1.44 m2)",
      "https://www.99.co/id/panduan/harga-borongan-pasang-granit-per-meter/ (upah Jakarta Rp110–200rb/m2)",
    ],
  },
  {
    id: "lantai_vinyl",
    group: "lantai",
    uraian: "Pasang lantai vinyl / SPC (bahan + upah)",
    satuan: "m2",
    basis: "floor_material_area",
    harga: { low: 150_000, mid: 210_000, high: 300_000 },
    upah: { low: 35_000, mid: 40_000, high: 40_000 },
    waste: 0.08,
    sources: [
      "https://rumahtaco.id/harga-lantai-vinyl-per-meter-dus/ (2026-04-14: 2mm Rp167.700, 3mm Rp213.700, SPC 5mm Rp295.700 terpasang; upah Rp35–40rb)",
      "https://www.mitra10.com/blog/harga-lantai-vinyl-per-meter (2026: sheet Rp90–160rb, plank Rp100–200rb, SPC Rp180–300rb material)",
      "https://craftedcalcs.com/guides/waste-factor-by-material/ (plank waste 7–10%)",
    ],
  },
  {
    id: "lantai_parket",
    group: "lantai",
    uraian: "Pasang lantai parket kayu / laminate (bahan + upah)",
    satuan: "m2",
    basis: "floor_material_area",
    harga: { low: 275_000, mid: 350_000, high: 520_000 },
    upah: { low: 35_000, mid: 42_000, high: 60_000 },
    waste: 0.08,
    estimate: true,
    sources: [
      "https://www.lantaikayu.biz/harga-lantai-kayu-parket/ (2026-05-21: laminate Rp240rb; jati C Rp160–191rb; jati A Rp265–381rb; merbau Rp335–531rb per m2)",
      "https://www.mitrajayainterior.com/blog/harga-jasa-pasang-serta-jasa-bongkar-parket-kayu-vinyl-untuk-tangga/ (jasa Rp35–42rb/m2)",
    ],
  },
  {
    id: "plint_keramik",
    group: "lantai",
    uraian: "Pasang plint keramik 10x40 (bahan + upah)",
    satuan: "m1",
    basis: "plint_length",
    harga: { low: 25_000, mid: 35_000, high: 50_000 },
    upah: { low: 18_500, mid: 22_000, high: 30_000 },
    waste: 0.05,
    sources: [
      "https://www.arsitur.com/2020/07/biaya-pemasangan-plin-keramik.html (2023: Rp36.113–37.763/m' all-in; volume = 2(p+l) − bukaan)",
      "https://realestat.id/harga-pasang-keramik-per-meter-2023-lengkap-dengan-jenis-bahan-dan-upah-bongkar/ (2025-04-16: upah Rp18.500/m')",
    ],
  },

  // ───────── III. DINDING ─────────
  {
    id: "plester_aci",
    group: "dinding",
    uraian: "Plester + aci dinding (bahan + upah)",
    satuan: "m2",
    basis: "wall_both_area",
    harga: { low: 75_000, mid: 90_000, high: 110_000 },
    upah: { low: 45_000, mid: 60_000, high: 75_000 },
    waste: 0,
    sources: [
      "https://realestat.id/harga-borongan-tenaga-plester-dan-acian-per-meter-terbaru-2025/ (2025-05-22: Rp65–85rb/m2, biasanya sudah plus material)",
      "https://semenmerahputih.com/id/berita/konstruksi/harga-borongan-plester-aci-terbaru (2026: plus material Rp80–100rb/m2)",
      "https://bimrab.id/koleksi/ahsp/434 (AHSP 3.7.9 Jakarta Pusat: Rp101.024/m2)",
      "https://perizinanrealestate.wordpress.com/wp-content/uploads/2017/03/sni-2837-2008-plesteran.pdf (SNI 2837:2008)",
    ],
  },

  // ───────── IV. PLAFON ─────────
  {
    id: "plafon_gypsum",
    group: "plafon",
    uraian: "Plafon gypsum 9 mm + rangka hollow galvalum (bahan + upah)",
    satuan: "m2",
    basis: "ceiling_area",
    harga: { low: 100_000, mid: 135_000, high: 175_000 },
    upah: { low: 40_000, mid: 55_000, high: 75_000 },
    waste: 0.1,
    sources: [
      "https://plafonrumahminimalis.com/daftar-harga-pasang-plafon-gypsum/ (2026 Jabodetabek: Aplus Rp135rb, Jayaboard Rp155rb/m2)",
      "https://pratamabaja.com/harga-borongan-pasang-plafon/ (2026-06 Jabodetabek: Rp150–185rb/m2; upah Rp52rb)",
      "https://ilhamplafon.com/borongan-pasang-plafon-gypsum/ (2025: Rp95–135rb/m2 all-in; upah Rp35–55rb)",
      "https://www.detik.com/properti/berita/d-7939984/kisaran-harga-gypsum-per-lembar-terbaru-2025-sesuai-ketebalan (2025-05-30: Jayaboard 9mm Rp69rb/lembar)",
      "https://bimrab.id/koleksi/ahsp/7144 (AHSP 3.5.2.1 gypsum board)",
      "https://craftedcalcs.com/guides/waste-factor-by-material/ (ceiling drywall waste 8–10%)",
    ],
  },

  // ───────── V. PINTU & JENDELA ─────────
  {
    id: "pintu_kamar_kayu",
    group: "pintu_jendela",
    uraian: "Pintu kamar kayu/HPL set (kusen + daun + kunci + pasang)",
    satuan: "unit",
    basis: "door_room_count",
    harga: { low: 1_500_000, mid: 2_300_000, high: 4_500_000 },
    waste: 0,
    estimate: true,
    sources: [
      "https://m.dekoruma.com/artikel/219954/interior-harga-kusen-pintu-kayu (2025-08-18: kusen kamper Rp400–560rb, meranti Rp800rb, merbau Rp1.255rb; daun kamper Rp1.1–1.25jt)",
      "https://suksesperkasaforestama.com/article/harga-pintu-plywood-lapis-hpl (2025-11-09: HPL Rp700rb–3.5jt/daun)",
      "https://www.sari-jati.com/harga-kusen-kayu-murah.html (2026: kusen pintu dari Rp625rb)",
      "https://www.detik.com/properti/berita/d-7936869/kisaran-harga-borongan-bangun-rumah-1-lantai-per-meter-terbaru-2025 (2025-05-28: upah pasang kusen Rp150–180rb/unit)",
    ],
  },
  {
    id: "pintu_km_pvc",
    group: "pintu_jendela",
    uraian: "Pintu kamar mandi PVC/UPVC set terpasang",
    satuan: "unit",
    basis: "door_bath_count",
    harga: { low: 800_000, mid: 1_400_000, high: 2_200_000 },
    waste: 0,
    sources: [
      "https://epic-window.com/harga-kusen-dan-pintu-pvc-untuk-kamar-mandi/ (2025: 70x215 Rp1.5jt, 80x215 Rp1.6jt terpasang incl. hardware)",
      "https://www.mitra10.com/jendela-pintu/pintu-kayu/pintu-hpl (Tidy PVC 70x195 Rp639rb; Doorway UPVC Rp1.296–1.329jt)",
      "https://suksesperkasaforestama.com/article/harga-pintu-pvc (total Rp1.1–2.2jt/unit; pasang Rp200–900rb)",
    ],
  },
  {
    id: "pintu_utama",
    group: "pintu_jendela",
    uraian: "Pintu utama kayu solid / aluminium set terpasang",
    satuan: "unit",
    basis: "door_main_count",
    harga: { low: 3_500_000, mid: 6_000_000, high: 10_000_000 },
    waste: 0,
    estimate: true,
    sources: [
      "https://www.mitra10.com/jendela-pintu/pintu-kayu/pintu-hpl (Willmore kayu karbon 80x200 Rp3.699jt; aluminium 215x96 Rp8.66jt)",
      "https://ykksinarfortuna.id/estimasi-biaya-pasang-jendela-dan-pintu-aluminium-2026/ (2026-01-19: Fronterra Rp7jt+, terpasang Rp10–15jt)",
    ],
  },
  {
    id: "jendela_alu",
    group: "pintu_jendela",
    uraian: "Jendela aluminium + kaca 5 mm terpasang",
    satuan: "m2",
    basis: "window_area",
    harga: { low: 850_000, mid: 1_200_000, high: 1_900_000 },
    waste: 0,
    minPerUnit: 600_000,
    minPerUnitCount: "window_count",
    sources: [
      "https://www.trideko.com/harga-jendela-aluminium/ (2026: 60x120 casement Rp600–750rb, sliding Rp675–900rb, fixed Rp375rb; kusen Alexindo 3\" Rp82.5–105rb/m, YKK 4\" Rp165–225rb/m; kaca 5mm Rp112.500/m2)",
      "https://pahome.co.id/id/blog/harga-jendela-aluminium/ (2026: fixed Rp850rb–1.6jt/m2; kusen terpasang 3\" ≈Rp337rb/m)",
      "https://ykksinarfortuna.id/estimasi-biaya-pasang-jendela-dan-pintu-aluminium-2026/ (2026-01-19: material+pasang Rp400–600rb/m)",
    ],
  },

  // ───────── VI. INSTALASI LISTRIK ─────────
  {
    id: "titik_lampu",
    group: "listrik",
    uraian: "Instalasi titik lampu + saklar (kabel, pipa, fitting, upah)",
    satuan: "titik",
    basis: "lamp_points",
    harga: { low: 180_000, mid: 250_000, high: 320_000 },
    upah: { low: 80_000, mid: 110_000, high: 150_000 },
    waste: 0,
    sources: [
      "https://jagoanlistrik.id/biaya-instalasi-listrik/ (2025: jasa lampu Rp80rb; plus material Rp200–245rb/titik)",
      "https://www.medcom.id/properti/news-properti/yKXLRq9K-harga-instalasi-listrik-per-titik-terbaru-november-2025-segini-biayanya (2025-11-05: Rp80–150rb jasa)",
      "https://www.brighton.co.id/about/articles-all/harga-borongan-bangunan-berdasarkan-jenis-pekerjaan-dan-spesifikasi-bangunannya (2025-12-16: Rp280rb/titik 2026)",
    ],
  },
  {
    id: "titik_stopkontak",
    group: "listrik",
    uraian: "Instalasi titik stop kontak (kabel, pipa, stop kontak, upah)",
    satuan: "titik",
    basis: "socket_points",
    harga: { low: 180_000, mid: 250_000, high: 320_000 },
    upah: { low: 80_000, mid: 110_000, high: 150_000 },
    waste: 0,
    sources: [
      "https://jagoanlistrik.id/biaya-instalasi-listrik/ (2025: plus material Rp200–259rb/titik)",
      "https://www.detik.com/properti/berita/d-7936869/kisaran-harga-borongan-bangun-rumah-1-lantai-per-meter-terbaru-2025 (2025-05-28: Rp250rb/titik)",
      "https://www.mitra10.com/blog/berapa-banyak-stop-kontak-untuk-rumah (2025-08-27: jumlah stop kontak per ruangan)",
    ],
  },

  // ───────── VII. PENGECATAN ─────────
  {
    id: "cat_interior",
    group: "pengecatan",
    uraian: "Cat dinding interior 2 lapis + cat dasar (bahan + upah)",
    satuan: "m2",
    basis: "wall_material_area",
    harga: { low: 38_000, mid: 55_000, high: 80_000 },
    upah: { low: 18_000, mid: 22_000, high: 27_000 },
    waste: 0.05,
    sources: [
      "https://www.builder.id/harga-borongan-cat/ (2026-05-29: upah Rp22–27rb; plus bahan Catylac 45rb, Mowilex 70rb, Dulux 85rb/m2)",
      "https://ilhamplafon.com/harga-borongan-cat-tembok-rumah-per-meter/ (2026-04-30 Jaktim: upah Rp18–23rb; plus bahan Catylac 35rb, Mowilex 52rb, Dulux 65rb)",
      "https://bimrab.id/koleksi/ahsp/4867 (AHSP 3.8.10.1: Rp43.270/m2 incl. 15% OHP, Jakarta Pusat)",
      "https://www.brighton.co.id/about/articles-all/simulasi-dan-cara-menghitung-kebutuhan-cat-tembok (2024-01-02: 10 m2/L/coat, 2 coats)",
      "https://www.wgstudio.id/analisa-pekerjaan-pengecatan/ (SNI variant with plamir)",
      "https://www.qhomemart.com/blog/harga-cat-dulux/ (2026-02-07: Catylac 4,5 kg Rp178.100)",
      "https://www.lamudi.co.id/journal/harga-borongan-cat-tembok/ (emulsion Rp50–150rb/L)",
    ],
  },
  {
    id: "cat_plafon",
    group: "pengecatan",
    uraian: "Cat plafon 2 lapis (bahan + upah)",
    satuan: "m2",
    basis: "ceiling_area",
    harga: { low: 35_000, mid: 50_000, high: 70_000 },
    upah: { low: 22_000, mid: 25_000, high: 27_000 },
    waste: 0.05,
    sources: [
      "https://www.builder.id/harga-borongan-cat/ (2026-05-29: upah plafon Rp22–27rb/m2)",
      "https://plafonrumahminimalis.com/daftar-harga-pasang-plafon-gypsum/ (2026: cat plafon Rp60rb/m2 with paint)",
    ],
  },
  {
    id: "cat_eksterior",
    group: "pengecatan",
    uraian: "Cat dinding eksterior weathershield 2 lapis (bahan + upah)",
    satuan: "m2",
    basis: "wall_exterior_area",
    harga: { low: 55_000, mid: 75_000, high: 95_000 },
    upah: { low: 25_000, mid: 32_000, high: 40_000 },
    waste: 0.05,
    estimate: true,
    sources: [
      "https://www.builder.id/harga-borongan-cat/ (2026-05-29: upah eksterior Rp28–35rb; Weathershield Rp32–37rb)",
      "https://ilhamplafon.com/harga-borongan-cat-tembok-rumah-per-meter/ (2026-04-30: upah eksterior Rp21–30rb)",
      "https://www.99.co/id/panduan/harga-borongan-cat-tembok/ (2025: Weathershield Rp26–29rb/m2 upah)",
      "aggregator/marketplace 2026 plus-bahan: Aquashield 60rb, Tough Shield 65rb, Weathershield 85rb, Jotashield 90–100rb/m2",
      "https://bimrab.id/koleksi/ahsp/4538 (AHSP 3.8.10.2: Rp38.985/m2, Jakarta Pusat)",
    ],
  },
];

export const RAB_ITEM_BY_ID: Readonly<Record<string, RabItem>> = Object.fromEntries(
  RAB_ITEMS.map((item) => [item.id, item]),
);

export type RabBenchmarkKey =
  | "bangunBaru"
  | "bangunBaruUpahSaja"
  | "renovasiRingan"
  | "renovasiSedang"
  | "renovasiBerat";

/** Per-m² benchmarks (sanity check beside the total, and the bangun_baru line). */
export const PER_M2_BENCHMARKS: Record<RabBenchmarkKey, Record<RabGrade, number>> = {
  // https://caribisnis.id/artikel/biaya-bangun-rumah-per-meter-2026 (2026-06-29: 3.5–4.5 / 4.5–6 / 6–10 jt)
  // https://www.brighton.co.id/about/articles-all/harga-borongan-bangunan-berdasarkan-jenis-pekerjaan-dan-spesifikasi-bangunannya (2025-12-16: 3.2–4.2 / 4.3–5.5 / 5.6–8 jt)
  bangunBaru: { low: 3_500_000, mid: 5_000_000, high: 8_000_000 },
  // brighton 0.9–1.6 jt; caribisnis 1.0–1.8 jt (upah saja)
  bangunBaruUpahSaja: { low: 900_000, mid: 1_300_000, high: 1_800_000 },
  // https://www.mitra10.com/blog/biaya-renovasi-rumah-per-meter (2026: 500–800rb)
  // https://www.rumah123.com/panduan-properti/estbiaya-renovasi-rumah-per-meter/ (2026-07-13: 500rb–1.5jt)
  renovasiRingan: { low: 500_000, mid: 800_000, high: 1_500_000 },
  // mitra10 900rb–1.5jt; rumah123 1.5–3.5jt
  renovasiSedang: { low: 900_000, mid: 1_500_000, high: 3_500_000 },
  // mitra10 1.5–2jt; rumah123 3.5–6jt
  renovasiBerat: { low: 1_500_000, mid: 3_000_000, high: 6_000_000 },
};

export const BENCHMARK_LABELS: Record<RabBenchmarkKey, string> = {
  bangunBaru: "bangun baru borongan",
  bangunBaruUpahSaja: "bangun baru (upah saja)",
  renovasiRingan: "renovasi ringan",
  renovasiSedang: "renovasi sedang",
  renovasiBerat: "renovasi berat",
};

/** The single per-m² line used by the bangun_baru paket (not part of RAB_ITEMS). */
export const BANGUN_BARU_ITEM: RabItem = {
  id: "bangun_baru_m2",
  group: "bangunan",
  uraian: "Bangun rumah borongan full material (struktur s/d finishing)",
  satuan: "m2",
  basis: "floor_area",
  harga: PER_M2_BENCHMARKS.bangunBaru,
  upah: PER_M2_BENCHMARKS.bangunBaruUpahSaja,
  waste: 0,
  sources: [
    "https://caribisnis.id/artikel/biaya-bangun-rumah-per-meter-2026 (2026-06-29: standar Rp3,5–4,5jt; menengah Rp4,5–6jt; mewah Rp6–10jt+ per m2)",
    "https://www.brighton.co.id/about/articles-all/harga-borongan-bangunan-berdasarkan-jenis-pekerjaan-dan-spesifikasi-bangunannya (2025-12-16: Rp3,2–4,2 / 4,3–5,5 / 5,6–8jt per m2)",
  ],
};

// Regional multipliers, base = Jabodetabek MID prices (most quotes are Jabodetabek/Jawa).
// Multiplier ≈ IKK(region) / IKK(Jakarta Pusat 119,26), BPS IKK 2025 (Surabaya = 100),
// sanity-checked against BPS Q2-2025 median upah tukang/hari.
// https://www.bps.go.id/en/publication/2025/10/01/935f3f46173c68d21b6c5126/indeks-kemahalan-konstruksi-provinsi-dan-kabupaten-kota-2025.html
// https://databoks.katadata.co.id/properti/statistik/40557b3f95b315f/indeks-kemahalan-konstruksi-kota-jakarta-pusat-dki-jakarta-2025 (119.26)
// https://databoks.katadata.co.id/en/property/statistics/8a2a851e459a7d2/bandung-city-construction-cost-index-in-west-java-reaches-11975-points-in-2025 (119.75)
// https://databoks.katadata.co.id/en/property/statistics/77bb0a64798be97/yogyakarta-city-construction-cost-index-special-region-of-yogyakarta-2025 (106.34)
// https://databoks.katadata.co.id/en/property/statistics/afd0d1646cd1185/surabaya-city-construction-cost-index-east-java-2025 (100.0)
// https://databoks.katadata.co.id/en/property/statistics/aa5d557291774ab/medan-city-north-sumatra-construction-cost-index-reaches-9352-points-in-2025 (93.52)
// https://goodstats.id/article/pemetaan-biaya-konstruksi-di-indonesia-mana-provinsi-paling-mahal-nel5Q (Kaltim 120.28, Papua 136.79, Papua Pegunungan 245.6)
// Upah: DKI 165rb, Jabar/Banten 150rb, Jatim 126rb, Jateng 110rb, DIY 100rb, Bali 125rb, Kaltim 160rb
// https://www.kompas.com/properti/read/2025/10/08/083655221/upah-tukang-harian-jakarta-tertinggi-diy-hingga-sulteng-terendah
export const REGION_MULTIPLIERS: Record<RabRegion, { label: string; factor: number; note: string }> = {
  jabodetabek: { label: "Jabodetabek", factor: 1.0, note: "Dasar harga; IKK Jakarta Pusat 119,26" },
  bandung: { label: "Bandung Raya", factor: 1.0, note: "IKK Kota Bandung 119,75" },
  jateng: { label: "Semarang / Jawa Tengah", factor: 0.88, note: "IKK Kota Semarang ≈105,5; upah tukang 110rb/hari" },
  diy: { label: "D.I. Yogyakarta", factor: 0.89, note: "IKK Kota Yogyakarta 106,34; upah tukang 100rb/hari" },
  jatim: { label: "Surabaya / Jawa Timur", factor: 0.85, note: "IKK Surabaya 100 (kota acuan BPS)" },
  jawa_lain: { label: "Jawa lainnya", factor: 0.9, note: "Asumsi" },
  bali: { label: "Bali", factor: 1.0, note: "Asumsi; sumber menyebut +10–25% dibanding Jawa" },
  sumatera: { label: "Sumatera", factor: 0.9, note: "IKK Kota Medan 93,52" },
  kalimantan: { label: "Kalimantan", factor: 1.0, note: "IKK Kalimantan Timur 120,28" },
  sulawesi: { label: "Sulawesi", factor: 0.9, note: "Asumsi (IKK Kotamobagu 98,74)" },
  nusa_tenggara: { label: "NTB / NTT", factor: 0.85, note: "IKK Sumbawa 93,15; Belu 76,68 (terendah)" },
  papua: { label: "Papua (dataran rendah)", factor: 1.15, note: "IKK Papua 136,79" },
  papua_pegunungan: { label: "Papua Pegunungan", factor: 2.0, note: "IKK Papua Pegunungan 245,6 (tertinggi)" },
};

export const REGION_ORDER: readonly RabRegion[] = [
  "jabodetabek",
  "bandung",
  "jateng",
  "diy",
  "jatim",
  "jawa_lain",
  "bali",
  "sumatera",
  "kalimantan",
  "sulawesi",
  "nusa_tenggara",
  "papua",
  "papua_pegunungan",
];

/** Demolition lines; included only when RabInputs.demolition is on. */
export const DEMOLITION_ITEM_IDS: readonly string[] = [
  "bongkar_lantai",
  "bongkar_plafon",
  "buang_puing",
];

export const PAKET: Record<
  RabPaket,
  { label: string; description: string; items: string[]; benchmark: RabBenchmarkKey }
> = {
  ringan: {
    label: "Renovasi ringan",
    description: "Cat, lantai, plint dan plafon",
    items: [
      ...DEMOLITION_ITEM_IDS,
      FLOOR_TOKEN,
      "plint_keramik",
      "plafon_gypsum",
      "cat_interior",
      "cat_plafon",
    ],
    benchmark: "renovasiRingan",
  },
  sedang: {
    label: "Renovasi sedang",
    description: "Ringan + plester, pintu/jendela, listrik, cat luar",
    items: [
      ...DEMOLITION_ITEM_IDS,
      FLOOR_TOKEN,
      "plint_keramik",
      "plester_aci",
      "plafon_gypsum",
      "pintu_kamar_kayu",
      "pintu_km_pvc",
      "pintu_utama",
      "jendela_alu",
      "titik_lampu",
      "titik_stopkontak",
      "cat_interior",
      "cat_plafon",
      "cat_eksterior",
    ],
    benchmark: "renovasiSedang",
  },
  bangun_baru: {
    label: "Bangun baru",
    description: "Harga borongan per m² (struktur s/d finishing)",
    items: [],
    benchmark: "bangunBaru",
  },
};

export const PAKET_ORDER: readonly RabPaket[] = ["ringan", "sedang", "bangun_baru"];

/** Conventional RAB kelompok (roman numerals are assigned per rekap). */
export const GROUP_LABELS: Record<RabGroup, string> = {
  persiapan: "Pekerjaan Persiapan & Pembongkaran",
  lantai: "Pekerjaan Lantai",
  dinding: "Pekerjaan Dinding",
  plafon: "Pekerjaan Plafon",
  pintu_jendela: "Pekerjaan Pintu & Jendela",
  listrik: "Pekerjaan Instalasi Listrik",
  pengecatan: "Pekerjaan Pengecatan",
  bangunan: "Pekerjaan Bangunan (borongan per m²)",
};

export const GROUP_ORDER: readonly RabGroup[] = [
  "persiapan",
  "lantai",
  "dinding",
  "plafon",
  "pintu_jendela",
  "listrik",
  "pengecatan",
  "bangunan",
];

export const GRADE_LABELS: Record<RabGrade, string> = {
  low: "Ekonomis",
  mid: "Standar",
  high: "Premium",
};

export const GRADE_ORDER: readonly RabGrade[] = ["low", "mid", "high"];

export const SATUAN_LABELS: Record<RabUnit, string> = {
  m2: "m²",
  m1: "m'",
  unit: "unit",
  titik: "titik",
  rit: "rit",
  ls: "ls",
};
