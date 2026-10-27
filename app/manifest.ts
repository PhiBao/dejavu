import type { MetadataRoute } from "next";

/**
 * Installable capture surface. The share target lets another app (Messages,
 * Mail, a browser) send text straight into Dejavu; the shortcut opens the
 * one-field quick capture screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dejavu — a memory companion",
    short_name: "Dejavu",
    description:
      "Capture anything worth remembering and ask for it back, cited, from Walrus-backed memory.",
    start_url: "/workspace",
    display: "standalone",
    background_color: "#f7f7f5",
    theme_color: "#0f1115",
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Quick capture",
        short_name: "Capture",
        url: "/capture",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
    ],
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
      },
    },
  } as MetadataRoute.Manifest;
}
