// CSV export of the RAB for Excel id-ID: UTF-8 BOM, ";" separator, CRLF,
// six columns (No | Uraian Pekerjaan | Volume | Satuan | Harga Satuan |
// Jumlah). Money is written as plain integers and volumes with a decimal
// comma so Excel id-ID parses both as numbers.

import {
  GRADE_LABELS,
  GRADE_ORDER,
  PAKET,
  REGION_MULTIPLIERS,
  SATUAN_LABELS,
} from "./data";
import { RAB_DISCLAIMERS, type Rekap } from "./compute";

const BOM = "﻿";
const SEP = ";";
const EOL = "\r\n";
const COLUMNS = 6;

export const CSV_HEADER = [
  "No",
  "Uraian Pekerjaan",
  "Volume",
  "Satuan",
  "Harga Satuan (Rp)",
  "Jumlah Harga (Rp)",
];

const cell = (value: string | number | null | undefined): string => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const row = (...cells: (string | number | null | undefined)[]): string => {
  const padded = [...cells];
  while (padded.length < COLUMNS) padded.push("");
  return padded.slice(0, COLUMNS).map(cell).join(SEP);
};

const decimal = (n: number, digits = 2): string => n.toFixed(digits).replace(".", ",");

const money = (n: number): string => String(Math.round(n));

export const rabToCsv = (
  rekap: Rekap,
  plan: FloorPlan,
  inputs: RabInputs,
  projectName: string,
): string => {
  const region = REGION_MULTIPLIERS[inputs.region];
  const q = rekap.quantities;
  const rows: string[] = [];

  rows.push(row("", "RENCANA ANGGARAN BIAYA (RAB) — ESTIMASI"));
  rows.push(row("", `Proyek: ${projectName || "Tanpa nama"}`));
  rows.push(row("", `Paket: ${PAKET[inputs.paket].label} (${PAKET[inputs.paket].description})`));
  rows.push(row("", `Kualitas: ${GRADE_LABELS[inputs.grade]}`));
  rows.push(row("", `Wilayah: ${region.label} (faktor ${decimal(rekap.regionFactor)})`));
  rows.push(row("", `Luas lantai denah: ${decimal(q.floor_area)} m²`));
  if (typeof inputs.luasBangunanM2 === "number" && inputs.luasBangunanM2 > 0) {
    rows.push(row("", `Luas bangunan (input): ${decimal(inputs.luasBangunanM2)} m²`));
  }
  rows.push(
    row(
      "",
      `Skala denah: ${plan.scale.confirmed ? "sudah dikonfirmasi" : "BELUM dikonfirmasi"}`,
    ),
  );
  rows.push(row("", `Versi harga: ${rekap.priceVersion}`));
  rows.push(row("", `Tanggal: ${new Date().toISOString().slice(0, 10)}`));
  rows.push(row());

  rows.push(row(...CSV_HEADER));
  for (const g of rekap.groups) {
    rows.push(row(g.roman, g.label));
    for (const line of g.lines) {
      if (!line.enabled) continue;
      const uraian = line.estimate ? `${line.item.uraian} (estimasi)` : line.item.uraian;
      rows.push(
        row(
          line.no,
          uraian,
          decimal(line.volume),
          SATUAN_LABELS[line.satuan],
          money(line.hargaSatuan),
          money(line.jumlah),
        ),
      );
    }
    rows.push(row("", `Sub Total ${g.label}`, "", "", "", money(g.subtotal)));
    rows.push(row());
  }

  rows.push(row("", "REKAPITULASI"));
  for (const g of rekap.groups) {
    rows.push(row(g.roman, g.label, "", "", "", money(g.subtotal)));
  }
  rows.push(row("", "Jumlah Harga Pekerjaan", "", "", "", money(rekap.jumlahPekerjaan)));
  rows.push(
    row(
      "",
      `Jasa Kontraktor ${decimal(rekap.contractorFeePct, 0)}%`,
      "",
      "",
      "",
      money(rekap.jasaKontraktor),
    ),
  );
  rows.push(
    row(
      "",
      rekap.includePpn
        ? `PPN ${rekap.ppnPct}% (PMK 131/2024)`
        : "PPN (tidak termasuk)",
      "",
      "",
      "",
      money(rekap.ppn),
    ),
  );
  rows.push(row("", "Total", "", "", "", money(rekap.total)));
  rows.push(row("", "Pembulatan", "", "", "", money(rekap.pembulatan)));
  rows.push(row("", "TOTAL (dibulatkan)", "", "", "", money(rekap.totalBulat)));
  rows.push(row("", `Terbilang: ${rekap.terbilang}`));
  rows.push(row());

  rows.push(
    row("", `Rentang kualitas (${GRADE_ORDER.map((g) => GRADE_LABELS[g]).join(" – ")})`),
  );
  for (const grade of GRADE_ORDER) {
    rows.push(row("", GRADE_LABELS[grade], "", "", "", money(rekap.gradeTotals[grade])));
  }
  rows.push(
    row(
      "",
      `Patokan ${rekap.benchmark.label} per m² (${decimal(rekap.benchmark.perM2Basis)} m²)`,
      "",
      "",
      "",
      `${money(rekap.benchmark.low)} – ${money(rekap.benchmark.high)}`,
    ),
  );
  rows.push(row());

  rows.push(row("", "Catatan"));
  for (const note of rekap.notes) rows.push(row("", note));
  RAB_DISCLAIMERS.forEach((text, i) => rows.push(row(i + 1, text)));

  return BOM + rows.join(EOL) + EOL;
};

/** "rab-<slug>-2026-09.csv" */
export const rabCsvFilename = (projectName: string, priceVersion: string): string => {
  const slug =
    (projectName || "proyek")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "proyek";
  return `rab-${slug}-${priceVersion}.csv`;
};

/** Browser only: saves the CSV through a temporary object URL. */
export const downloadCsv = (csv: string, filename: string): boolean => {
  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (error) {
    console.error("downloadCsv failed:", error);
    return false;
  }
};
