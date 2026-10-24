import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static site: `npm run build` writes plain HTML/JS to ./out.
  output: "export",
  // Set BASE_PATH (e.g. "/rif2rap-web") when hosting under a sub-path such as GitHub Pages.
  basePath: process.env.BASE_PATH || undefined,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
