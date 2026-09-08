const api = window.termdockDesktop;

const elements = {
  notice: document.querySelector('#notice'),
  refresh: document.querySelector('#refresh'),
  localState: document.querySelector('#local-state'),
  localDetail: document.querySelector('#local-detail'),
  localAddress: document.querySelector('#local-address'),
  visualStatus: document.querySelector('#visual-status'),
  navLocalDot: document.querySelector('#nav-local-dot'),
  connectLocal: document.querySelector('#connect-local'),
  startLocal: document.querySelector('#start-local'),
  cliState: document.querySelector('#cli-state'),
  cliDetail: document.querySelector('#cli-detail'),
  installCli: document.querySelector('#install-cli'),
  menuBarStatusEnabled: document.querySelector('#menu-bar-status-enabled'),
  floatingWidgetEnabled: document.querySelector('#floating-widget-enabled'),
  desktopStatusPreview: document.querySelector('#desktop-status-preview'),
  connectionCount: document.querySelector('#connection-count'),
  version: document.querySelector('#version'),
  startupProgress: document.querySelector('#startup-progress'),
  startupProgressMessage: document.querySelector('#startup-progress-message'),
};

let currentSnapshot = null;


api.onStartupProgress?.((message) => {
  elements.startupProgress.hidden = !message;
  if (message) elements.startupProgressMessage.textContent = message;
});

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle('error', error);
  elements.notice.hidden = false;
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = '';
}

async function busy(button, task) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  clearNotice();
  try {
    return await task();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function render(snapshot) {
  currentSnapshot = snapshot;
  elements.version.textContent = snapshot.runtimeVersion === snapshot.appVersion
    ? `Termdock Desktop ${snapshot.appVersion}`
    : `Termdock Desktop ${snapshot.appVersion} · Runtime ${snapshot.runtimeVersion}`;
  elements.connectionCount.textContent = String(snapshot.connections.length);

  const local = snapshot.localService;
  elements.localState.querySelector('span').textContent = local.running ? '运行中' : '未运行';
  elements.localState.classList.toggle('ok', local.running);
  elements.navLocalDot.classList.toggle('ok', local.running);
  elements.visualStatus.textContent = local.running ? 'service online' : 'service offline';
  elements.connectLocal.hidden = !local.running;
  if (local.running && local.state) {
    const version = local.probe?.version ? ` · v${local.probe.version}` : '';
    const serviceUrl = local.probe?.url || local.state.localUrl;
    elements.localAddress.textContent = serviceUrl || 'localhost';
    elements.localDetail.textContent = `PID ${local.state.pid}${version}`;
    elements.startLocal.textContent = '由桌面版接管';
  } else {
    elements.localAddress.textContent = 'localhost:9834';
    elements.localDetail.textContent = '等待桌面版或 CLI 启动';
    elements.startLocal.textContent = '由桌面版启动';
  }

  const cli = snapshot.cliInstallations;
  const bundled = cli.find((entry) => entry.bundled);
  elements.cliState.textContent = bundled ? '已连接桌面版本' : (cli.length > 0 ? '检测到其他版本' : '未安装');
  elements.cliState.classList.toggle('ok', Boolean(bundled));
  elements.cliDetail.textContent = cli.length > 0
    ? cli.map((entry) => `${entry.path} · ${entry.version || '版本未知'}${entry.bundled ? ' · 桌面内嵌' : ''}`).join('\n')
    : `桌面内嵌版本 ${snapshot.bundledCliVersion}，尚未安装命令入口。`;
  elements.installCli.hidden = !snapshot.packaged;
  elements.menuBarStatusEnabled.checked = snapshot.desktopPreferences.menuBarStatusEnabled;
  elements.floatingWidgetEnabled.checked = snapshot.desktopPreferences.floatingWidgetEnabled;


}

async function saveDesktopPreference(input, key) {
  const previous = !input.checked;
  input.disabled = true;
  clearNotice();
  try {
    currentSnapshot = await api.updateDesktopPreferences({ [key]: input.checked });
    render(currentSnapshot);
  } catch (error) {
    input.checked = previous;
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    input.disabled = false;
  }
}

async function refresh() {
  currentSnapshot = await api.snapshot();
  render(currentSnapshot);
}

elements.refresh.addEventListener('click', () => {
  void busy(elements.refresh, refresh);
});

elements.connectLocal.addEventListener('click', () => {
  void busy(elements.connectLocal, async () => {
    const url = currentSnapshot?.localService?.probe?.url;
    if (!url) throw new Error('本机服务地址不可用');
    const result = await api.connect(url);
    if (!result.ok) showNotice(result.error || '连接失败', true);
  });
});

elements.startLocal.addEventListener('click', () => {
  void busy(elements.startLocal, async () => {
    const result = await api.startLocal();
    if (!result.ok) showNotice(result.error || '服务启动失败', true);
  });
});

elements.installCli.addEventListener('click', () => {
  void busy(elements.installCli, async () => {
    currentSnapshot = await api.installCli();
    render(currentSnapshot);
    showNotice('CLI 安装状态已刷新。');
  });
});

elements.menuBarStatusEnabled.addEventListener('change', () => {
  void saveDesktopPreference(elements.menuBarStatusEnabled, 'menuBarStatusEnabled');
});

elements.floatingWidgetEnabled.addEventListener('change', () => {
  void saveDesktopPreference(elements.floatingWidgetEnabled, 'floatingWidgetEnabled');
});

void refresh().catch((error) => {
  showNotice(error instanceof Error ? error.message : String(error), true);
});

api.onDesktopStatus((status) => {
  elements.desktopStatusPreview.textContent = status.text;
  elements.desktopStatusPreview.title = status.tooltip;
});
void api.desktopStatus().then((status) => {
  elements.desktopStatusPreview.textContent = status.text;
  elements.desktopStatusPreview.title = status.tooltip;
});
