import { useOutletContext } from "react-router";

/** Reads the context provided by app/routes/visualizer.$id.tsx via <Outlet context>. */
export const useVisualizer = (): VisualizerContext =>
  useOutletContext<VisualizerContext>();
