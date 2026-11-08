import './styles.css';
import './seed-data.js';
import './app.js';
import { initBridge } from './bridge.js';

// 初始化安卓桥接：本地到期推送 + 导出“保存/分享” + 返回键
initBridge();
