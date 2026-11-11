import { createRoot } from 'react-dom/client';
import { AgentBridge } from './agent/bridge.ts';
import { createDirectorApi } from './agent/api.ts';
import { app } from './app/app.ts';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const api = createDirectorApi(app);
window.director = api;

createRoot(document.getElementById('root')!).render(<App />);

void app.init().then(() => {
  if (app.ui.getState().server.connected) new AgentBridge(app, api);
  console.info('%c3D 導演台 ready — window.director.help() for the agent API', 'color:#ffb020');
});
