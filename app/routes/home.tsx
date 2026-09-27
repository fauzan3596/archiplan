import type { Route } from "./+types/home";
import Navbar from "../../components/Navbar";
import { ArrowRight, ArrowUpRight, Clock, Layers } from "lucide-react";
import Upload from "../../components/Upload";
import { Link, useNavigate, useOutletContext } from "react-router";
import { useEffect, useRef, useState } from "react";
import { createProject, getProjects } from "../../lib/puter.action";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Archiplan" },
    {
      name: "description",
      content: "Turn 2D floor plans into photorealistic 3D renders with AI.",
    },
  ];
}

export default function Home() {
  const navigate = useNavigate();
  const { isSignedIn, userId } = useOutletContext<AuthContext>();
  const [projects, setProjects] = useState<DesignItem[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const isCreatingProjectRef = useRef(false);

  const handleUploadComplete = async (base64Image: string) => {
    if (isCreatingProjectRef.current) return false;
    isCreatingProjectRef.current = true;

    try {
      const newId = Date.now().toString();
      const name = `Residence ${newId}`;

      const newItem = {
        id: newId,
        name,
        sourceImage: base64Image,
        renderedImage: undefined,
        timestamp: Date.now(),
      };

      const saved = await createProject({ item: newItem, visibility: "private" });

      if (!saved) {
        console.error("Failed to create project");
        return false;
      }

      setProjects((prev) => [saved, ...prev]);
      navigate(`/visualizer/${newId}`);

      return true;
    } finally {
      isCreatingProjectRef.current = false;
    }
  };

  useEffect(() => {
    if (!isSignedIn) {
      setProjects([]);
      return;
    }

    let isMounted = true;
    setIsLoadingProjects(true);

    getProjects().then((items) => {
      if (!isMounted) return;
      setProjects(items);
      setIsLoadingProjects(false);
    });

    return () => {
      isMounted = false;
    };
  }, [isSignedIn]);

  return (
    <div className="home">
      <Navbar />
      <section className="hero">
        <div className="announce">
          <div className="dot">
            <div className="pulse" />
          </div>

          <p>Introducing Archiplan 1.0</p>
        </div>

        <h1>Build beautiful spaces at the speed of thought with Archiplan</h1>

        <p className="subtitle">
          Archiplan is an AI-first design environment that helps you visualize,
          render, and ship architectural projects faster than ever.
        </p>

        <div className="actions">
          <a href="#upload" className="cta">
            Start Building <ArrowRight className="icon" />
          </a>

          <Link to="/visualizer/demo" className="demo">
            Coba Demo 3D
          </Link>
        </div>

        <div id="upload" className="upload-shell">
          <div className="grid-overlay" />

          <div className="upload-card">
            <div className="upload-head">
              <div className="upload-icon">
                <Layers className="icon" />
              </div>

              <h3>Upload your floor plan</h3>
              <p>Supports JPG, PNG, formats up to 10MB</p>
            </div>

            <Upload onComplete={handleUploadComplete} />
          </div>
        </div>
      </section>
      <section className="projects">
        <div className="section-inner">
          <div className="section-head">
            <div className="copy">
              <h2>Projects</h2>
              <p>
                Your latest work and shared community projects, all in one place
              </p>
            </div>
          </div>
          <div className="projects-grid">
            {projects.length === 0 && (
              <div className="empty">
                {!isSignedIn
                  ? "Sign in to see your projects and the community feed."
                  : isLoadingProjects
                    ? "Loading projects..."
                    : "No projects yet. Upload a floor plan to get started."}
              </div>
            )}

            {projects.map(
              ({
                id,
                name,
                renderedImage,
                sourceImage,
                timestamp,
                ownerId,
                ownerName,
                isPublic,
              }) => {
                const isOwn = ownerId === userId;
                const badge = isOwn
                  ? isPublic
                    ? "Public"
                    : "Private"
                  : "Community";

                return (
                  <div
                    key={id}
                    className="project-card group"
                    onClick={() => navigate(`/visualizer/${id}`)}
                  >
                    <div className="preview">
                      <img
                        src={renderedImage || sourceImage}
                        alt="Project Preview"
                      />
                      <div className="badge">
                        <span>{badge}</span>
                      </div>
                    </div>
                    <div className="card-body">
                      <div>
                        <h3>{name}</h3>
                        <div className="meta">
                          <Clock size={12} />
                          <span>
                            {new Date(timestamp).toLocaleDateString()}
                          </span>
                          <span>
                            By {isOwn ? "You" : ownerName || "Community"}
                          </span>
                        </div>
                      </div>
                      <div className="arrow">
                        <ArrowUpRight size={18} />
                      </div>
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
