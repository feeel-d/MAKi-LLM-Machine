import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// GitHub Pages 배포는 production 빌드의 `/MAKi-LLM-Machine/` base 유지. 로컬 `npm run dev`는 `/` 로 열기.
export default defineConfig(function (_a) {
    var mode = _a.mode;
    return ({
        base: mode === 'development' ? '/' : '/MAKi-LLM-Machine/',
        plugins: [react()],
        server: {
            port: 5173,
        },
    });
});
