import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapProgress } from './data/progress-ledger'
import './styles/global.css'

// 进度节点台账先行就位：列表页、导出、册子、交付清单统一从台账取数。
bootstrapProgress()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
