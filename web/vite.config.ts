import { defineConfig } from "vite";

// 상대 경로(base './')로 빌드해서 GitHub Pages 프로젝트 경로(/News_Summary/)든 어디든 동작하게 한다.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
});
