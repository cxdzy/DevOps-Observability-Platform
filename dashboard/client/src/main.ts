import { createApp } from 'vue'
import App from './App.vue'
// Bundled fonts, latin only: the Content Security Policy allows fonts from this site only.
import '@fontsource/geist/latin-400.css'
import '@fontsource/geist/latin-500.css'
import '@fontsource/geist/latin-600.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import './style.css'

createApp(App).mount('#app')
