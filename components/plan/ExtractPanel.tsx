// Shown by the plan route while the project has no plan. Owners start an AI
// extraction (through the shell-hosted ctx.extraction controller, so a 1-2
// minute call survives tab switches and lands via setPlan), or skip AI with
// the sample plan or the manual template (both through onPlanReady).

import { useEffect, useState } from "react";
import {
  Clock,
  CreditCard,
  ExternalLink,
  Info,
  LayoutTemplate,
  LogIn,
  PenLine,
  RefreshCcw,
  Replace,
  ScanLine,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import Button from "../ui/Button";
import { useVisualizer } from "../../lib/visualizer.context";
import { createEmptyPlan } from "../../lib/plan/defaults";
import {
  DEFAULT_EXTRACTION_MODEL_ID,
  EXTRACTION_MODELS,
  extractFloorPlan,
  getExtractionModel,
  isMockMode,
  loadImageSize,
  loadSamplePlan,
  type ExtractErrorCode,
} from "../../lib/plan/extract";

interface ExtractPanelProps {
  onPlanReady: (plan: FloorPlan) => Promise<boolean>;
}

const FALLBACK_IMAGE_SIZE: PlanImageSize = { w: 1000, h: 800 };
const PUTER_BILLING_URL = "https://puter.com/dashboard#billing";
const RATE_LIMIT_WAIT_S = 3;
const IDR_PER_USD = 16_500;

const costLine = (cents: number): string => {
  const usd = cents.toLocaleString("id-ID", { maximumFractionDigits: 1 });
  const rupiah = Math.round(((cents / 100) * IDR_PER_USD) / 50) * 50;
  return `± ${usd} sen USD / ~Rp ${rupiah.toLocaleString("id-ID")} per percobaan, maks 2 panggilan, tidak dapat dibatalkan`;
};

const FLOW_STEPS: { title: string; body: string }[] = [
  {
    title: "AI membaca denah",
    body: "Model AI mengenali dinding, pintu, jendela, ukuran, dan nama ruangan dari gambar Anda (± 1–2 menit).",
  },
  {
    title: "Anda periksa di editor 2D",
    body: "Hasil AI tidak pernah sempurna: rapikan dinding, cek skala, dan beri nama ruangan.",
  },
  {
    title: "Walkthrough 3D & RAB",
    body: "Denah yang sudah benar dipakai untuk model 3D, simulasi matahari, dan estimasi biaya.",
  },
];

interface ErrorCopy {
  title: string;
  body: string;
}

const errorCopy = (code: string): ErrorCopy => {
  switch (code as ExtractErrorCode) {
    case "insufficient_funds":
      return {
        title: "Kredit Puter habis",
        body: "Saldo AI akun Puter Anda tidak cukup untuk ekstraksi. Isi ulang di Puter, atau lanjutkan tanpa AI.",
      };
    case "rate_limited":
      return {
        title: "Terlalu banyak permintaan",
        body: "Puter membatasi permintaan untuk sementara. Tunggu sebentar lalu coba lagi.",
      };
    case "auth_canceled":
      return {
        title: "Masuk dibatalkan",
        body: "Ekstraksi memerlukan akun Puter. Masuk lalu coba lagi.",
      };
    case "unauthorized":
      return {
        title: "Sesi Puter berakhir",
        body: "Silakan masuk kembali ke Puter lalu coba lagi.",
      };
    case "model_unsupported":
      return {
        title: "Model tidak mendukung gambar",
        body: "Model ini tidak menerima input gambar di Puter. Ganti ke model lain lalu coba lagi.",
      };
    case "no_tool_call":
    case "invalid_output":
    case "output_truncated":
      return {
        title: "AI belum menghasilkan denah yang valid",
        body: "Sudah dicoba 2 kali. Coba model lain, gambar manual, atau pakai denah contoh.",
      };
    case "image_error":
      return {
        title: "Gambar denah tidak dapat dibaca",
        body: "Pastikan gambar proyek masih tersedia, lalu coba lagi atau gambar manual.",
      };
    case "network":
      return {
        title: "Koneksi gagal",
        body: "Periksa koneksi internet Anda lalu coba lagi.",
      };
    case "upstream":
      return {
        title: "Layanan AI sedang bermasalah",
        body: "Penyedia model sedang gangguan. Coba lagi beberapa saat lagi atau ganti model.",
      };
    default:
      return {
        title: "Ekstraksi gagal",
        body: "Terjadi kesalahan yang tidak terduga. Coba lagi atau gunakan alternatif di bawah.",
      };
  }
};

const ExtractPanel = ({ onPlanReady }: ExtractPanelProps) => {
  const ctx = useVisualizer();
  const { project, isOwner, isDemo, extraction, signIn } = ctx;
  const { state } = extraction;
  const sourceImage = project?.sourceImage ?? "";
  // The demo project never spends AI credit: it always uses the fixture.
  const mock = isMockMode() || isDemo;

  const [modelId, setModelId] = useState(DEFAULT_EXTRACTION_MODEL_ID);
  const [confirming, setConfirming] = useState(false);
  const [imageSize, setImageSize] = useState<PlanImageSize | null>(null);
  const [imageSizeFailed, setImageSizeFailed] = useState(false);
  const [altBusy, setAltBusy] = useState<"sample" | "manual" | null>(null);
  const [altError, setAltError] = useState<string | null>(null);
  const [waitS, setWaitS] = useState(0);
  const [starting, setStarting] = useState(false);

  const running = state.status === "running" || starting;
  const errorCode = state.status === "error" ? state.error?.code ?? "unknown" : null;
  const model = getExtractionModel(modelId);

  useEffect(() => {
    if (!sourceImage) return;
    let cancelled = false;
    setImageSizeFailed(false);
    loadImageSize(sourceImage)
      .then((size) => {
        if (!cancelled) setImageSize(size);
      })
      .catch((e) => {
        console.error("ExtractPanel: could not read the image size:", e);
        if (cancelled) return;
        setImageSize(FALLBACK_IMAGE_SIZE);
        setImageSizeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceImage]);

  // rate_limited: "Coba lagi" unlocks after a short wait.
  useEffect(() => {
    if (errorCode !== "rate_limited") {
      setWaitS(0);
      return;
    }
    setWaitS(RATE_LIMIT_WAIT_S);
    const timer = setInterval(() => {
      setWaitS((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [errorCode, state.startedAt]);

  const resolveImageSize = async (): Promise<PlanImageSize> => {
    if (imageSize) return imageSize;
    if (!sourceImage) return FALLBACK_IMAGE_SIZE;
    try {
      return await loadImageSize(sourceImage);
    } catch {
      return FALLBACK_IMAGE_SIZE;
    }
  };

  const startExtraction = async () => {
    setConfirming(false);
    setAltError(null);
    const latest = ctx.projectRef.current ?? project;
    const src = latest?.sourceImage ?? sourceImage;
    if (!src || running) return;
    setStarting(true);
    try {
      const size = await resolveImageSize();
      const chosen = modelId;
      // The controller refuses a second job for this project and writes the
      // result through the shell's setPlan (onDone), not through this panel.
      const job = extraction.run(chosen, (report) =>
        extractFloorPlan({ sourceImage: src, imageSize: size, modelId: chosen, onProgress: report, mock }),
      );
      setStarting(false);
      await job;
    } finally {
      setStarting(false);
    }
  };

  const askAgain = () => {
    extraction.reset();
    setConfirming(true);
  };

  const handleSignIn = async () => {
    try {
      await signIn();
    } catch (e) {
      console.error("ExtractPanel: sign-in failed:", e);
    }
    extraction.reset();
  };

  const switchModel = () => {
    const next = EXTRACTION_MODELS.find((m) => m.id !== (state.modelId ?? modelId)) ?? EXTRACTION_MODELS[0];
    setModelId(next.id);
    extraction.reset();
    setConfirming(true);
  };

  const applyAlternative = async (kind: "sample" | "manual") => {
    if (running || altBusy) return;
    setAltBusy(kind);
    setAltError(null);
    try {
      const size = await resolveImageSize();
      const plan = kind === "sample" ? loadSamplePlan(size) : createEmptyPlan({ imageSize: size });
      const ok = await onPlanReady(plan);
      if (!ok) {
        setAltError(
          kind === "sample"
            ? "Denah contoh gagal disimpan. Coba lagi."
            : "Template denah gagal disimpan. Coba lagi.",
        );
      }
    } catch (e) {
      console.error("ExtractPanel: alternative plan failed:", e);
      setAltError("Terjadi kesalahan saat menyiapkan denah. Coba lagi.");
    } finally {
      setAltBusy(null);
    }
  };

  const nextModel = EXTRACTION_MODELS.find((m) => m.id !== (state.modelId ?? modelId));
  const runningModel = getExtractionModel(state.modelId ?? modelId);
  const elapsedS = Math.max(0, Math.floor(state.elapsedMs / 1000));

  const altButtons = (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void applyAlternative("sample")}
        disabled={running || altBusy !== null}
      >
        <LayoutTemplate className="w-4 h-4 mr-2" />
        {altBusy === "sample" ? "Menyiapkan…" : "Coba denah contoh"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void applyAlternative("manual")}
        disabled={running || altBusy !== null}
      >
        <PenLine className="w-4 h-4 mr-2" />
        {altBusy === "manual" ? "Menyiapkan…" : "Gambar manual"}
      </Button>
    </>
  );

  const renderError = () => {
    if (!errorCode) return null;
    const copy = errorCopy(errorCode);
    const funds = errorCode === "insufficient_funds";
    const auth = errorCode === "auth_canceled" || errorCode === "unauthorized";

    return (
      <div className={`extract-error${funds ? " is-funds" : ""}`} role="alert">
        <div className="extract-error-head">
          {funds ? <CreditCard className="icon" /> : <TriangleAlert className="icon" />}
          <div>
            <h4>{copy.title}</h4>
            <p>{copy.body}</p>
            {state.error?.message ? <p className="extract-error-detail">{state.error.message}</p> : null}
          </div>
        </div>
        <div className="extract-error-actions">
          {funds ? (
            <>
              <a className="extract-link" href={PUTER_BILLING_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" />
                Buka Puter
              </a>
              {altButtons}
            </>
          ) : auth ? (
            <Button size="sm" onClick={() => void handleSignIn()}>
              <LogIn className="w-4 h-4 mr-2" />
              Masuk ke Puter
            </Button>
          ) : errorCode === "model_unsupported" && nextModel ? (
            <Button size="sm" onClick={switchModel}>
              <Replace className="w-4 h-4 mr-2" />
              Ganti ke {nextModel.label}
            </Button>
          ) : errorCode === "rate_limited" ? (
            <Button size="sm" onClick={askAgain} disabled={waitS > 0}>
              <RefreshCcw className="w-4 h-4 mr-2" />
              {waitS > 0 ? `Coba lagi (${waitS})` : "Coba lagi"}
            </Button>
          ) : (
            <Button size="sm" onClick={askAgain}>
              <RefreshCcw className="w-4 h-4 mr-2" />
              Coba lagi
            </Button>
          )}
          {!funds ? (
            <Button variant="ghost" size="sm" onClick={() => extraction.reset()}>
              Tutup
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderRunner = () => {
    if (running) {
      return (
        <div className="extract-running" aria-live="polite">
          <RefreshCcw className="spinner" />
          <div className="extract-running-copy">
            <span className="title">{state.step ?? "Memulai…"}</span>
            <span className="subtitle">
              {runningModel.label} · <Clock className="inline-icon" /> {elapsedS} dtk
            </span>
            <span className="hint">
              Proses tidak dapat dibatalkan. Anda boleh membuka tab lain; hasilnya tetap tersimpan ke proyek.
            </span>
          </div>
          <Button size="sm" disabled className="extract-locked">
            Sedang mengekstrak…
          </Button>
        </div>
      );
    }

    return (
      <div className="extract-run">
        <label className="extract-field">
          <span>Model AI</span>
          <select
            value={modelId}
            onChange={(e) => {
              setModelId(e.target.value);
              setConfirming(false);
            }}
            disabled={confirming}
          >
            {EXTRACTION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.supportsTools === "assumed" ? `${m.label} · belum diverifikasi` : m.label}
              </option>
            ))}
          </select>
        </label>
        <p className="extract-cost">{costLine(model.estCostCents)}</p>
        {mock ? (
          <p className="extract-mock">
            <Info className="inline-icon" /> Mode contoh aktif: tidak memanggil Puter dan tidak memotong kredit.
          </p>
        ) : null}
        {confirming ? (
          <div className="extract-confirm" role="group" aria-label="Konfirmasi ekstraksi">
            {mock ? (
              <p>
                Jalankan ekstraksi contoh dengan <strong>{model.label}</strong>? Mode contoh tidak memanggil Puter dan
                tidak ada biaya.
              </p>
            ) : (
              <p>
                Jalankan ekstraksi dengan <strong>{model.label}</strong>? Biaya {costLine(model.estCostCents)}. Kredit
                dipotong dari akun Puter Anda.
              </p>
            )}
            <div className="extract-confirm-actions">
              <Button size="sm" onClick={() => void startExtraction()}>
                <WandSparkles className="w-4 h-4 mr-2" />
                Ya, ekstrak
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Batal
              </Button>
            </div>
          </div>
        ) : (
          <Button
            onClick={() => {
              setAltError(null);
              setConfirming(true);
            }}
            disabled={!sourceImage}
            className="extract-start"
          >
            <ScanLine className="w-4 h-4 mr-2" />
            Ekstrak denah
          </Button>
        )}
        {state.status === "done" ? (
          <p className="extract-note">Denah selesai dibuat. Membuka editor…</p>
        ) : null}
      </div>
    );
  };

  return (
    <section className="panel extract-panel">
      <header className="extract-head">
        <p className="eyebrow">Denah 2D</p>
        <h3>Buat denah dari gambar</h3>
        <p>Ubah gambar denah proyek ini menjadi denah vektor yang bisa diedit, dijelajahi dalam 3D, dan dihitung RAB-nya.</p>
      </header>

      <ol className="extract-flow">
        {FLOW_STEPS.map((step, i) => (
          <li key={step.title}>
            <span className="num">{i + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {!isOwner ? (
        <p className="extract-note">Hanya pemilik proyek yang dapat membuat denah.</p>
      ) : !sourceImage ? (
        <p className="extract-note">Proyek ini belum memiliki gambar denah.</p>
      ) : (
        <div className="extract-body">
          {errorCode ? renderError() : renderRunner()}
          {imageSizeFailed ? (
            <p className="extract-note">
              Ukuran gambar tidak terbaca; dipakai 1000 × 800 px sehingga overlay bisa bergeser.
            </p>
          ) : null}
        </div>
      )}

      {isOwner ? (
        <footer className="extract-alt">
          <p>Tanpa AI:</p>
          {/* the 402 card already shows these two buttons */}
          {errorCode === "insufficient_funds" ? null : <div className="extract-alt-actions">{altButtons}</div>}
          <p className="extract-alt-hint">
            Denah contoh adalah rumah 10 × 8 m (bukan gambar Anda) untuk mencoba editor, 3D, dan RAB tanpa kredit.
            Gambar manual memulai dari persegi 10 × 8 m.
          </p>
          {altError ? <p className="extract-alt-error">{altError}</p> : null}
        </footer>
      ) : null}
    </section>
  );
};

export default ExtractPanel;
