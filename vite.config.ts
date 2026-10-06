import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

// Kennung dieses Builds; die App vergleicht sie mit version.json und lädt nach einem Deploy neu
const BUILD_ID = Date.now().toString(36);

const versionFile = (): Plugin => ({
  name: 'version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
  },
});

// --mode phone: selbstsigniertes HTTPS, damit Sensoren/Kamera im LAN auf dem Handy funktionieren
export default defineConfig(({ mode }) => ({
  base: './',
  worker: { format: 'es' },
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID) },
  plugins: [versionFile(), ...(mode === 'phone' ? [basicSsl()] : [])],
}));
