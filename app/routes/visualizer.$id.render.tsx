import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Download, RefreshCcw, Sparkles } from "lucide-react";
import {
  ReactCompareSlider,
  ReactCompareSliderImage,
} from "react-compare-slider";
import Button from "../../components/ui/Button";
import { generate3DView } from "../../lib/ai.action";
import { useVisualizer } from "../../lib/visualizer.context";

// In-flight AI renders keyed by project id. They live at module level so that
// switching tabs mid-render neither restarts the job nor loses its spinner.
const renderJobs = new Map<string, Promise<void>>();
const attemptedRenders = new Set<string>();

const VisualizerRender = () => {
  const { projectId, project, isProjectLoading, isOwner, isDemo, saveProject } =
    useVisualizer();

  const [isProcessing, setIsProcessing] = useState(() =>
    renderJobs.has(projectId),
  );
  const [currentImage, setCurrentImage] = useState<string | null>(
    project?.renderedImage || null,
  );

  const handleExport = async () => {
    if (!currentImage) return;

    // Hosted renders live on another origin, where the `download` attribute
    // is ignored, so go through an object URL instead.
    let href = currentImage;
    let objectUrl: string | null = null;

    if (!currentImage.startsWith("data:")) {
      try {
        const response = await fetch(currentImage);
        objectUrl = URL.createObjectURL(await response.blob());
        href = objectUrl;
      } catch (error) {
        console.error("Failed to fetch render for export:", error);
      }
    }

    const link = document.createElement("a");
    link.href = href;
    link.download = `archiplan-${projectId || "design"}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };

  const runGeneration = (item: DesignItem) => {
    if (!item.id || !item.sourceImage) return;

    attemptedRenders.add(item.id);

    const job = (async () => {
      const result = await generate3DView({ sourceImage: item.sourceImage });

      if (!result.renderedImage) return;

      setCurrentImage(result.renderedImage);

      // Saved from the latest project ref; the timestamp is never bumped.
      const saved = await saveProject({
        renderedImage: result.renderedImage,
        renderedPath: result.renderedPath,
      });

      if (saved?.renderedImage) setCurrentImage(saved.renderedImage);
    })()
      .catch((error) => {
        console.error("Generation failed:", error);
      })
      .finally(() => {
        renderJobs.delete(item.id);
      });

    renderJobs.set(item.id, job);
    setIsProcessing(true);
    void job.finally(() => setIsProcessing(false));
  };

  // Re-attach to a render that is still running after a tab switch.
  useEffect(() => {
    const job = renderJobs.get(projectId);
    if (!job) return;

    let isMounted = true;
    setIsProcessing(true);
    void job.finally(() => {
      if (isMounted) setIsProcessing(false);
    });

    return () => {
      isMounted = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (isProjectLoading || !project?.sourceImage) return;

    if (project.renderedImage) {
      setCurrentImage(project.renderedImage);
      return;
    }

    // Visitors can view a shared project but must not render or save it, and
    // the demo never spends AI credit.
    if (!isOwner || isDemo) return;

    if (renderJobs.has(project.id) || attemptedRenders.has(project.id)) return;

    runGeneration(project);
  }, [project, isProjectLoading, isOwner, isDemo]);

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-meta">
            <p>Render</p>
            <h3>AI Render</h3>
          </div>
          <div className="panel-actions">
            <Button
              size="sm"
              onClick={handleExport}
              className="export"
              disabled={!currentImage}
            >
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          </div>
        </div>

        <div className={`render-area ${isProcessing ? "is-processing" : ""}`}>
          {currentImage ? (
            <img src={currentImage} alt="AI Render" className="render-img" />
          ) : (
            <div className="render-placeholder">
              {project?.sourceImage && (
                <img
                  src={project.sourceImage}
                  alt="Original"
                  className="render-fallback"
                />
              )}
            </div>
          )}

          {isDemo && !currentImage && (
            <div className="render-overlay">
              <div className="rendering-card demo-card">
                <Sparkles className="status-icon" />
                <span className="title">Mode demo</span>
                <span className="subtitle">
                  Render AI tidak dijalankan di demo. Coba denahnya di tab lain:
                </span>
                <div className="demo-links">
                  <Link to="plan">Denah 2D</Link>
                  <Link to="3d">Walkthrough 3D</Link>
                  <Link to="rab">RAB</Link>
                </div>
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="render-overlay">
              <div className="rendering-card">
                <RefreshCcw className="spinner" />
                <span className="title">Rendering...</span>
                <span className="subtitle">
                  Generating your 3D visualization
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel compare">
        <div className="panel-header">
          <div className="panel-meta">
            <p>Comparison</p>
            <h3>Before and After</h3>
          </div>
          <div className="hint">Drag to compare</div>
        </div>

        <div className="compare-stage">
          {project?.sourceImage && currentImage ? (
            <ReactCompareSlider
              defaultValue={50}
              style={{ width: "100%", height: "auto" }}
              itemOne={
                <ReactCompareSliderImage
                  src={project.sourceImage}
                  alt="Before"
                  className="compare-img"
                />
              }
              itemTwo={
                <ReactCompareSliderImage
                  src={currentImage}
                  alt="After"
                  className="compare-img"
                />
              }
            />
          ) : (
            <div className="compare-fallback">
              {project?.sourceImage && (
                <img
                  src={project.sourceImage}
                  alt="Before"
                  className="compare-img"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default VisualizerRender;
