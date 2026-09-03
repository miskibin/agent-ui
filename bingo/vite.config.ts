import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH is set by the Pages workflow (`/agent-ui/bingo/`); a root deploy needs nothing.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
});
