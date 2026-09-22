import { createApp } from 'vue'
import App from './App.vue'
import { initTheme } from './theme'

initTheme()

createApp(App).mount('#app')