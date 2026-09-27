import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("visualizer/:id", "./routes/visualizer.$id.tsx", [
    index("./routes/visualizer.$id.render.tsx"),
    route("plan", "./routes/visualizer.$id.plan.tsx"),
    route("3d", "./routes/visualizer.$id.3d.tsx"),
    route("rab", "./routes/visualizer.$id.rab.tsx"),
  ]),
] satisfies RouteConfig;
