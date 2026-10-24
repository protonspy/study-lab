import { resolve } from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

const shared = resolve(__dirname, "src/shared")

export default defineConfig({
  main: {
    resolve: { alias: { "@shared": shared } },
    build: { rollupOptions: { external: ["node:sqlite"] } },
  },
  preload: {
    resolve: { alias: { "@shared": shared } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": shared,
      },
    },
    build: { chunkSizeWarningLimit: 3000 },
  },
})
