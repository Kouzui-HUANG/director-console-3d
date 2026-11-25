import { createRoot } from 'react-dom/client';
import '../ui/styles.css';
import { createPortraitApi } from './agent/api.ts';
import { studio } from './app.ts';
import { App } from './ui/App.tsx';
import './ui/portrait.css';

window.portrait = createPortraitApi(studio);
(window as unknown as { __studio: typeof studio }).__studio = studio; // dev inspection
createRoot(document.getElementById('root')!).render(<App />);
console.info('%c人像工作室 ready — window.portrait', 'color:#ffb020');
