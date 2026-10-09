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
  prepareLocal: document.querySelector('#prepare-local'),
  localInstallHint: document.querySelector('#local-install-hint'),
  localDiagnostics: document.querySelector('#local-diagnostics'),
  localDiagnosticsContent: document.querySelector('#local-diagnostics-content'),
  menuBarStatusEnabled: document.querySelector('#menu-bar-status-enabled'),
  floatingWidgetEnabled: document.querySelector('#floating-widget-enabled'),
  desktopStatusPreview: document.querySelector('#desktop-status-preview'),
  connectionCount: document.querySelector('#connection-count'),
  version: document.querySelector('#version'),
  startupProgress: document.querySelector('#startup-progress'),
  startupProgressMessage: document.querySelector('#startup-progress-message'),
};

let currentSnapshot = null;
let localActionPending = false;
let refreshPending = null;
let setupRevision = 0;


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
  elements.version.textContent = `Termdock Desktop ${snapshot.appVersion}`;
  elements.connectionCount.textContent = String(snapshot.connections.length);

  const local = snapshot.localService;
  const setup = local.setup || { phase: 'checking', message: '正在检测本机服务和运行环境…' };
  const labels = {
    checking: '检测中', starting: '启动中', installing: '安装中',
    'needs-node': '需要运行环境', 'needs-install': '尚未安装', error: '需要处理', ready: '服务已停止',
  };
  const pending = localActionPending || ['checking', 'starting', 'installing'].includes(setup.phase);
  elements.localState.querySelector('span').textContent = local.running ? '运行中' : labels[setup.phase];
  elements.localState.classList.toggle('ok', local.running);
  elements.localState.classList.toggle('pending', !local.running && pending);
  elements.localState.classList.toggle('error', !local.running && setup.phase === 'error');
  elements.navLocalDot.classList.toggle('ok', local.running);
  elements.visualStatus.textContent = local.running ? '本机服务已就绪' : labels[setup.phase];
  elements.connectLocal.hidden = !local.running;
  elements.prepareLocal.hidden = local.running;
  elements.prepareLocal.disabled = pending;
  elements.refresh.disabled = pending;
  const actionLabels = {
    checking: '正在检测…', starting: '正在启动…', installing: '正在安装…',
    'needs-node': '下载 Node.js', 'needs-install': '安装并启动', error: '重试检测与启动', ready: '启动本机服务',
  };
  elements.prepareLocal.textContent = actionLabels[setup.phase];
  elements.localInstallHint.hidden = local.running || !['needs-node', 'needs-install', 'installing'].includes(setup.phase);
  elements.localInstallHint.textContent = setup.phase === 'needs-node'
    ? '将打开 Node.js 官网。完成安装后回到此页，应用会自动继续检测。'
    : '将从 npm 下载 Termdock 并安装到当前用户目录，完成后自动启动。首次安装可能需要安装系统依赖。';
  const diagnostics = [
    setup.nodeVersion && `Node.js ${setup.nodeVersion}`,
    setup.cliPath && `Termdock CLI: ${setup.cliPath}`,
    local.state && `服务 PID: ${local.state.pid}`,
    setup.details,
  ].filter(Boolean).join('\n');
  elements.localDiagnostics.hidden = !diagnostics;
  elements.localDiagnosticsContent.textContent = diagnostics;
  if (local.running) {
    const version = local.probe?.version ? ` · v${local.probe.version}` : '';
    const serviceUrl = local.probe?.url || local.state?.localUrl;
    elements.localAddress.textContent = serviceUrl || 'localhost';
    elements.localDetail.textContent = `本机服务已就绪${version}，可以打开工作空间。`;
  } else {
    elements.localAddress.textContent = local.state?.localUrl || `localhost:${local.state?.port || 9834}`;
    elements.localDetail.textContent = setup.phase === 'ready' ? '服务已停止，点击下方即可重新启动。' : setup.message;
  }

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
  if (refreshPending) return refreshPending;
  const revision = setupRevision;
  refreshPending = api.snapshot().then(snapshot => {
    if (revision !== setupRevision && currentSnapshot?.localService.setup) {
      snapshot.localService.setup = currentSnapshot.localService.setup;
    }
    render(snapshot);
  }).finally(() => { refreshPending = null; });
  return refreshPending;
}

async function prepareLocal(install = false) {
  if (localActionPending) return;
  localActionPending = true;
  clearNotice();
  if (currentSnapshot) render(currentSnapshot);
  try {
    render(await api.prepareLocalService(install));
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    localActionPending = false;
    if (currentSnapshot) render(currentSnapshot);
  }
}

elements.refresh.addEventListener('click', () => { void prepareLocal(); });

elements.prepareLocal.addEventListener('click', () => {
  if (currentSnapshot?.localService.setup?.phase === 'needs-node') {
    void busy(elements.prepareLocal, () => api.downloadNode());
    return;
  }
  // An explicit retry also resumes a failed or interrupted CLI installation.
  void prepareLocal(true);
});

api.onLocalServiceSetup((setup) => {
  setupRevision += 1;
  if (currentSnapshot) {
    currentSnapshot.localService.setup = setup;
    render(currentSnapshot);
  }
  if (setup.phase === 'ready') void refresh().catch(() => {});
});

async function checkEnvironment() {
  if (document.hidden || localActionPending) return;
  try {
    if (currentSnapshot?.localService.setup?.phase === 'needs-node') await prepareLocal();
    else await refresh();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

window.addEventListener('focus', () => { void checkEnvironment(); });
setInterval(() => { void checkEnvironment(); }, 10_000);

elements.connectLocal.addEventListener('click', () => {
  void busy(elements.connectLocal, async () => {
    const url = currentSnapshot?.localService?.probe?.url;
    if (!url) throw new Error('本机服务地址不可用');
    const result = await api.connect(url);
    if (!result.ok) showNotice(result.error || '连接失败', true);
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
