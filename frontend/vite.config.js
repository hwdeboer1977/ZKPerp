import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    define: {
        'process.env': {},
    },
    server: {
        proxy: {
            // Compliance / backend server on :3001
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            },
            // Aleo explorer — dodges browser CORS. Browser hits same-origin
            // /aleo-api/..., Vite forwards to api.explorer.provable.com server-side.
            '/aleo-api': {
                target: 'https://api.provable.com',
                changeOrigin: true,
                secure: true,
                rewrite: function (p) { return p.replace(/^\/aleo-api/, '/v2'); },
            },
        },
    },
});
