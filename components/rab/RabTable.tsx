// Conventional Indonesian RAB table: No | Uraian Pekerjaan | Volume | Satuan |
// Harga Satuan | Jumlah, grouped by kelompok with Sub Total rows. Owners get
// inline volume / harga overrides and an enable checkbox per line.

import { Info, RotateCcw } from "lucide-react";
import { formatIDR, formatVolume, type RabLine, type Rekap } from "../../lib/rab/compute";
import { GRADE_LABELS, REGION_MULTIPLIERS, SATUAN_LABELS } from "../../lib/rab/data";
import { NumberDraftInput } from "./RabInputs";

const factorFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const plainIDR = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

interface RabTableProps {
  rekap: Rekap;
  inputs: RabInputs;
  editable: boolean;
  onOverride: (itemId: string, patch: RabLineOverride | null) => void;
}

interface LineRowProps {
  line: RabLine;
  editable: boolean;
  onOverride: (itemId: string, patch: RabLineOverride | null) => void;
}

const wasteTitle = (line: RabLine) =>
  `Termasuk sisa material ${line.wastePct}% dari volume bersih ${formatVolume(line.baseVolume)} ${SATUAN_LABELS[line.satuan]}`;

const LineRow = ({ line, editable, onOverride }: LineRowProps) => {
  const id = line.item.id;
  const unit = SATUAN_LABELS[line.satuan];

  return (
    <tr className={`line-row ${line.enabled ? "" : "is-disabled"}`}>
      <td className="col-no">{line.no}</td>
      <td className="col-uraian">
        <span className="uraian">{line.item.uraian}</span>
        <span className="line-tags">
          {line.estimate && (
            <span
              className="rab-badge is-estimate"
              title="Belum ada sumber harga bertanggal; diturunkan dari angka di sekitarnya"
            >
              estimasi
            </span>
          )}
          {line.minApplied && (
            <span
              className="rab-badge"
              title="Jendela kecil: harga minimum per unit diterapkan"
            >
              min. per unit
            </span>
          )}
          {line.overridden && <span className="rab-badge is-override">diubah</span>}
          <span
            className="rab-source"
            title={`Sumber harga:\n${line.item.sources.join("\n")}`}
            aria-label="Sumber harga"
          >
            <Info className="w-3.5 h-3.5" />
          </span>
          {editable && line.overridden && (
            <button
              type="button"
              className="rab-reset"
              onClick={() => onOverride(id, null)}
              title="Kembalikan ke hitungan otomatis"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Reset
            </button>
          )}
        </span>
      </td>
      <td className="col-num">
        <span className="cell-num">
          {editable ? (
            <NumberDraftInput
              className="rab-cell-input"
              ariaLabel={`Volume ${line.item.uraian}`}
              value={line.volume}
              min={0}
              format={formatVolume}
              onCommit={(v) => onOverride(id, { volume: v })}
            />
          ) : (
            formatVolume(line.volume)
          )}
          {line.wastePct > 0 && (
            <span className="rab-waste" title={wasteTitle(line)}>
              +{line.wastePct}%
            </span>
          )}
        </span>
      </td>
      <td className="col-unit">{unit}</td>
      <td className="col-num">
        {editable ? (
          <NumberDraftInput
            className="rab-cell-input is-money"
            kind="integer"
            ariaLabel={`Harga satuan ${line.item.uraian}`}
            value={line.hargaSatuan}
            min={0}
            format={(v) => plainIDR.format(v)}
            onCommit={(v) => onOverride(id, { harga: v })}
          />
        ) : (
          formatIDR(line.hargaSatuan)
        )}
      </td>
      <td className="col-num col-jumlah">{formatIDR(line.jumlah)}</td>
      {editable && (
        <td className="col-toggle">
          <input
            type="checkbox"
            checked={line.enabled}
            aria-label={`Hitung ${line.item.uraian}`}
            onChange={(e) => onOverride(id, { enabled: e.target.checked ? null : false })}
          />
        </td>
      )}
    </tr>
  );
};

const RabTable = ({ rekap, inputs, editable, onOverride }: RabTableProps) => {
  const columns = editable ? 7 : 6;
  const region = REGION_MULTIPLIERS[inputs.region];

  return (
    <section className="panel rab-table-panel" aria-label="Rincian RAB">
      <div className="panel-header">
        <div className="panel-meta">
          <p>Rencana Anggaran Biaya</p>
          <h3>Rincian pekerjaan</h3>
          <p className="note">
            Kualitas {GRADE_LABELS[inputs.grade]} · {region.label} ×
            {factorFormat.format(rekap.regionFactor)} · versi harga {rekap.priceVersion}
          </p>
        </div>
        {editable && (
          <p className="rab-hint">Klik volume atau harga untuk mengubahnya; hapus isian untuk kembali ke hitungan otomatis.</p>
        )}
      </div>

      {rekap.groups.length === 0 ? (
        <p className="rab-empty">Tidak ada item pekerjaan untuk paket ini.</p>
      ) : (
        <div className="rab-table-wrap">
          <table className="rab-table">
            <thead>
              <tr>
                <th className="col-no">No</th>
                <th className="col-uraian">Uraian Pekerjaan</th>
                <th className="col-num">Volume</th>
                <th className="col-unit">Satuan</th>
                <th className="col-num">Harga Satuan</th>
                <th className="col-num">Jumlah</th>
                {editable && <th className="col-toggle">Hitung</th>}
              </tr>
            </thead>
            {rekap.groups.map((g) => (
              <tbody key={g.group}>
                <tr className="group-row">
                  <td className="col-no">{g.roman}</td>
                  <td colSpan={columns - 1}>{g.label}</td>
                </tr>
                {g.lines.map((line) => (
                  <LineRow
                    key={line.item.id}
                    line={line}
                    editable={editable}
                    onOverride={onOverride}
                  />
                ))}
                <tr className="subtotal-row">
                  <td className="col-no" />
                  <td colSpan={4}>Sub Total {g.label}</td>
                  <td className="col-num">{formatIDR(g.subtotal)}</td>
                  {editable && <td />}
                </tr>
              </tbody>
            ))}
          </table>
        </div>
      )}

      {rekap.notes.length > 0 && (
        <ul className="rab-notes">
          {rekap.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default RabTable;
