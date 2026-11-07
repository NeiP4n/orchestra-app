import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://github.com/NeiP4n/orchestra-app",
  base: "/posts",
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [mdx()],
  vite: {
    server: {
      allowedHosts: true,
    },
  },
})
