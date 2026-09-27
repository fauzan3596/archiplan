// Rekapitulasi: group subtotals -> Jumlah Harga Pekerjaan -> Jasa Kontraktor ->
// PPN -> Total -> Pembulatan -> total dibulatkan + terbilang, the
// Ekonomis–Standar–Premium range, the per-m² benchmark sanity line, the
// LUAS_MISMATCH warning, disclaimers and the gated "Unduh CSV" button.

import { Link } from "react-router";
import { AlertTriangle, Download, Lock } from "lucide-react";
import Button from "../ui/Button";
import { RAB_DISCLAIMERS, formatIDR, type Rekap } from "../../lib/rab/compute";
import { GRADE_LABELS, GRADE_ORDER, PAKET, REGION_MULTIPLIERS } from "../../lib/rab/data";

const areaFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const pctFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

interface RabRekapProps {
  rekap: Rekap;
  inputs: RabInputs;
  onExport: () => void;
}

const benchmarkStatus = (rekap: Rekap): { tone: "ok" | "warn"; text: string } | null => {
  const { low, high, perM2Basis } = rekap.benchmark;
  if (perM2Basis <= 0 || rekap.totalBulat <= 0) return null;
  if (rekap.totalBulat < low) {
    return { tone: "warn", text: "di bawah patokan — periksa skala dan item yang dinonaktifkan" };
  }
  if (rekap.totalBulat > high) {
    return { tone: "warn", text: "di atas patokan — periksa skala dan harga yang diubah" };
  }
  return { tone: "ok", text: "dalam rentang patokan" };
};

const RabRekap = ({ rekap, inputs, onExport }: RabRekapProps) => {
  const q = rekap.quantities;
  const status = benchmarkStatus(rekap);
  const perM2 = q.floor_area > 0 ? Math.round(rekap.totalBulat / q.floor_area) : null;

  return (
    <section className="panel rab-rekap" aria-label="Rekapitulasi RAB">
      <div className="panel-header">
        <div className="panel-meta">
          <p>Rekapitulasi</p>
          <h3>Total estimasi</h3>
          <p className="note">
            {PAKET[inputs.paket].label} · {GRADE_LABELS[inputs.grade]} ·{" "}
            {REGION_MULTIPLIERS[inputs.region].label}
          </p>
        </div>
      </div>

      <div className="rab-rekap-body">
        <dl className="rekap-rows">
          {rekap.groups.map((g) => (
            <div className="rekap-row" key={g.group}>
              <dt>
                {g.roman}. {g.label}
              </dt>
              <dd>{formatIDR(g.subtotal)}</dd>
            </div>
          ))}
          <div className="rekap-row is-sum">
            <dt>Jumlah Harga Pekerjaan</dt>
            <dd>{formatIDR(rekap.jumlahPekerjaan)}</dd>
          </div>
          <div className="rekap-row">
            <dt>Jasa Kontraktor {rekap.contractorFeePct}%</dt>
            <dd>{formatIDR(rekap.jasaKontraktor)}</dd>
          </div>
          <div className="rekap-row">
            <dt>
              {rekap.includePpn
                ? `PPN ${rekap.ppnPct}% (PMK 131/2024)`
                : "PPN (tidak termasuk)"}
            </dt>
            <dd>{formatIDR(rekap.ppn)}</dd>
          </div>
          <div className="rekap-row is-sum">
            <dt>Total</dt>
            <dd>{formatIDR(rekap.total)}</dd>
          </div>
          <div className="rekap-row">
            <dt>Pembulatan</dt>
            <dd>{formatIDR(rekap.pembulatan)}</dd>
          </div>
        </dl>

        <div className="rekap-total">
          <span className="eyebrow">Total dibulatkan</span>
          <strong>{formatIDR(rekap.totalBulat)}</strong>
          <p className="terbilang">
            Terbilang: <em>{rekap.terbilang}</em>
          </p>
        </div>

        <div className="rekap-range">
          <span className="eyebrow">
            Rentang kualitas ({GRADE_ORDER.map((g) => GRADE_LABELS[g]).join(" – ")})
          </span>
          <p>
            {GRADE_ORDER.map((grade, i) => (
              <span key={grade} className={grade === inputs.grade ? "is-active" : ""}>
                {i > 0 && <span className="sep"> – </span>}
                {GRADE_LABELS[grade]} {formatIDR(rekap.gradeTotals[grade])}
              </span>
            ))}
          </p>
        </div>

        {perM2 !== null && (
          <p className={`rekap-benchmark ${status?.tone === "warn" ? "is-warn" : ""}`}>
            Setara {formatIDR(perM2)}/m² dari luas lantai {areaFormat.format(q.floor_area)} m².
            Patokan {rekap.benchmark.label}: {formatIDR(rekap.benchmark.rateLow)}–
            {formatIDR(rekap.benchmark.rateHigh)}/m² ({formatIDR(rekap.benchmark.low)} –{" "}
            {formatIDR(rekap.benchmark.high)}){status ? `, ${status.text}.` : "."}
          </p>
        )}

        {rekap.luasMismatch && q.luasMismatchPct !== null && (
          <div className="rab-warn" role="alert">
            <AlertTriangle className="w-4 h-4 mr-2" />
            <p>
              Luas denah {areaFormat.format(q.floor_area)} m² berbeda{" "}
              {pctFormat.format(q.luasMismatchPct)}% dari luas bangunan{" "}
              {areaFormat.format(inputs.luasBangunanM2 ?? 0)} m². Periksa skala di{" "}
              <Link to="../plan">Denah 2D</Link>.
            </p>
          </div>
        )}

        <div className="rab-export">
          <Button
            size="sm"
            className="export"
            onClick={onExport}
            disabled={!rekap.exportGate.ok}
          >
            {rekap.exportGate.ok ? (
              <Download className="w-4 h-4 mr-2" />
            ) : (
              <Lock className="w-4 h-4 mr-2" />
            )}
            Unduh CSV
          </Button>
          {!rekap.exportGate.ok && (
            <ul className="gate-reasons">
              {rekap.exportGate.reasons.map((r) => (
                <li key={r.code}>{r.message}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="rab-disclaimers">
          <span className="eyebrow">Catatan penting</span>
          <ul>
            {RAB_DISCLAIMERS.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default RabRekap;
