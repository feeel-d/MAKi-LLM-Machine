import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    base: '/MAKi-LLM-Machine/',
    plugins: [react()],
    server: {
        port: 5173,
    },
});
