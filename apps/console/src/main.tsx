import { createRoot } from 'react-dom/client';
import App from '@limeiot/control-ui/workspace/App.tsx';
import '@limeiot/control-ui/tokens.css';
import '@limeiot/control-ui/workspace/styles.css';

try {
  const theme = localStorage.getItem('limeiot-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* 无法读取偏好时跟随系统。 */ }
const locale = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN';
createRoot(document.getElementById('root')!).render(<App audience="console" locale={locale} deployment={{ basePath: '/console/' }} />);
