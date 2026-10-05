import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// --mode phone: selbstsigniertes HTTPS, damit Sensoren/Kamera im LAN auf dem Handy funktionieren
export default defineConfig(({ mode }) => ({
  base: './',
  worker: { format: 'es' },
  plugins: mode === 'phone' ? [basicSsl()] : [],
}));
