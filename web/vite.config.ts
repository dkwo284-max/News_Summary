import { defineConfig } from "vite";

// 상대 경로(base './')로 빌드해서 GitHub Pages 프로젝트 경로(/News_Summary/)든 어디든 동작하게 한다.
export default defineConfig({
  base: "./",
  // 두 페이지: 데일리 브리프(index.html)와 '주말 나들이'(leisure.html) — 같은 데이터 폴더를 함께 씀
  build: { outDir: "dist", emptyOutDir: true, target: "es2020",
    rollupOptions: { input: { main: "index.html", leisure: "leisure.html" } } },
});
