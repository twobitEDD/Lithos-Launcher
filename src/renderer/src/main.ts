import '@fontsource-variable/inter'
import '@fontsource/syne/latin-700.css'
import '@fontsource/syne/latin-800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@xterm/xterm/css/xterm.css'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import SoatApp from './SoatApp.svelte'

// `#soat` is the standalone SOAT Miner window (`--soat`); everything else is Lithos Launcher.
const target = document.getElementById('app')!
if (location.hash === '#soat') {
  document.title = 'SOAT Miner'
  mount(SoatApp, { target })
} else {
  mount(App, { target })
}
