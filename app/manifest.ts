import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Iris",
    short_name: "Iris",
    description: "A private personal agent for the things that matter now.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "portrait",
    lang: "en",
    dir: "ltr",
    background_color: "#f5f7fb",
    theme_color: "#f5f7fb",
    icons: [
      {
        src: "/icons/iris-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/iris-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
