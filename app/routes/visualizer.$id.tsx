import { useNavigate, useOutletContext, useParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { generate3DView } from "../../lib/ai.action";
import {
  Box,
  Check,
  Download,
  Globe,
  Lock,
  RefreshCcw,
  Share2,
  X,
} from "lucide-react";
import Button from "../../components/ui/Button";
import { createProject, getProjectById } from "../../lib/puter.action";
import {
  ReactCompareSlider,
  ReactCompareSliderImage,
} from "react-compare-slider";

const LINK_COPIED_RESET_MS = 2000;

const VisualizerId = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isSignedIn, isAuthReady, userId, signIn } =
    useOutletContext<AuthContext>();

  const hasInitialGenerated = useRef(false);
  const linkCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [project, setProject] = useState<DesignItem | null>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(true);

  const [isProcessing, setIsProcessing] = useState(false);
  const [currentImage, setCurrentImage] = useState<string | null>(null);

  const [isUpdatingVisibility, setIsUpdatingVisibility] = useState(false);
  const [isLinkCopied, setIsLinkCopied] = useState(false);

  const isOwner = Boolean(project && userId && project.ownerId === userId);

  const handleBack = () => navigate("/");

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
    link.download = `archiplan-${id || "design"}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };

  const updateVisibility = async (isPublic: boolean) => {
    if (!project || !isOwner) return null;

    try {
      setIsUpdatingVisibility(true);

      const saved = await createProject({
        item: { ...project, isPublic },
        visibility: isPublic ? "public" : "private",
      });

      if (saved) setProject(saved);

      return saved ?? null;
    } finally {
      setIsUpdatingVisibility(false);
    }
  };

  const handleToggleVisibility = () => {
    if (!project) return;
    void updateVisibility(!project.isPublic);
  };

  const handleShare = async () => {
    if (!project) return;

    // Only public projects can be opened by others, so sharing a private
    // project publishes it first.
    if (isOwner && !project.isPublic) {
      const saved = await updateVisibility(true);
      if (!saved) return;
    }

    const shareUrl = window.location.href;

    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      window.prompt("Copy this link to share the project:", shareUrl);
      return;
    }

    setIsLinkCopied(true);
    if (linkCopiedTimeoutRef.current) {
      clearTimeout(linkCopiedTimeoutRef.current);
    }
    linkCopiedTimeoutRef.current = setTimeout(
      () => setIsLinkCopied(false),
      LINK_COPIED_RESET_MS,
    );
  };

  const runGeneration = async (item: DesignItem) => {
    if (!id || !item.sourceImage) return;

    try {
      setIsProcessing(true);
      const result = await generate3DView({ sourceImage: item.sourceImage });

      if (result.renderedImage) {
        setCurrentImage(result.renderedImage);

        const updatedItem = {
          ...item,
          renderedImage: result.renderedImage,
          renderedPath: result.renderedPath,
          timestamp: Date.now(),
        };

        const saved = await createProject({ item: updatedItem });

        if (saved) {
          setProject(saved);
          setCurrentImage(saved.renderedImage || result.renderedImage);
        }
      }
    } catch (error) {
      console.error("Generation failed:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    return () => {
      if (linkCopiedTimeoutRef.current) {
        clearTimeout(linkCopiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadProject = async () => {
      if (!isAuthReady) return;

      if (!id || !isSignedIn) {
        setProject(null);
        setCurrentImage(null);
        setIsProjectLoading(false);
        return;
      }

      setIsProjectLoading(true);

      const fetchedProject = await getProjectById({ id });

      if (!isMounted) return;

      setProject(fetchedProject);
      setCurrentImage(fetchedProject?.renderedImage || null);
      setIsProjectLoading(false);
      hasInitialGenerated.current = false;
    };

    loadProject();

    return () => {
      isMounted = false;
    };
  }, [id, isSignedIn, isAuthReady]);

  useEffect(() => {
    if (
      isProjectLoading ||
      hasInitialGenerated.current ||
      !project?.sourceImage
    )
      return;

    if (project.renderedImage) {
      setCurrentImage(project.renderedImage);
      hasInitialGenerated.current = true;
      return;
    }

    // Visitors can view a shared project but must not render or save it.
    if (!isOwner) return;

    hasInitialGenerated.current = true;
    void runGeneration(project);
  }, [project, isProjectLoading, isOwner]);

  const renderStatus = () => {
    if (isProcessing) {
      return (
        <div className="rendering-card">
          <RefreshCcw className="spinner" />
          <span className="title">Rendering...</span>
          <span className="subtitle">Generating your 3D visualization</span>
        </div>
      );
    }

    if (isAuthReady && !isSignedIn) {
      return (
        <div className="rendering-card">
          <Lock className="status-icon" />
          <span className="title">Sign in to view this project</span>
          <span className="subtitle">
            Projects are loaded from your Puter account
          </span>
          <Button size="sm" onClick={() => void signIn()} className="action">
            Log In
          </Button>
        </div>
      );
    }

    if (isProjectLoading) {
      return (
        <div className="rendering-card">
          <RefreshCcw className="spinner" />
          <span className="title">Loading project...</span>
        </div>
      );
    }

    if (!project) {
      return (
        <div className="rendering-card">
          <X className="status-icon" />
          <span className="title">Project not found</span>
          <span className="subtitle">
            It may have been deleted or made private by its owner
          </span>
          <Button size="sm" onClick={handleBack} className="action">
            Back to Home
          </Button>
        </div>
      );
    }

    return null;
  };

  const status = renderStatus();

  return (
    <div className="visualizer">
      <nav className="topbar">
        <div className="brand">
          <Box className="logo" />
          <span className="name">Archiplan</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleBack} className="exit">
          <X className="icon" />
          Exit Editor
        </Button>
      </nav>

      <section className="content">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-meta">
              <p>Project</p>
              <h2>{project?.name || `Residence ${id}`}</h2>
              {project && (
                <p className="note">
                  {isOwner
                    ? `Created by You · ${project.isPublic ? "Public" : "Private"}`
                    : `Shared by ${project.ownerName || "a community member"}`}
                </p>
              )}
            </div>

            <div className="panel-actions">
              {isOwner && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleToggleVisibility}
                  className="visibility"
                  disabled={isUpdatingVisibility}
                >
                  {project?.isPublic ? (
                    <>
                      <Globe className="w-4 h-4 mr-2" /> Public
                    </>
                  ) : (
                    <>
                      <Lock className="w-4 h-4 mr-2" /> Private
                    </>
                  )}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleExport}
                className="export"
                disabled={!currentImage}
              >
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              <Button
                size="sm"
                onClick={handleShare}
                className="share"
                disabled={!project || isUpdatingVisibility}
              >
                {isLinkCopied ? (
                  <>
                    <Check className="w-4 h-4 mr-2" /> Link Copied
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4 mr-2" /> Share
                  </>
                )}
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

            {status && <div className="render-overlay">{status}</div>}
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
      </section>
    </div>
  );
};

export default VisualizerId;
