import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Iris",
    short_name: "Iris",
    description: "A private personal agent.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f6fb",
    theme_color: "#f4f6fb",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
