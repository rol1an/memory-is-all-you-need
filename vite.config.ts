import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5610,
    proxy: {
      '/api': 'http://localhost:5611',
      '/ws': { target: 'ws://localhost:5611', ws: true },
    },
  },
})
