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
  elements.version.textContent = `Termdock Desktop ${snapshot.appVersion}`;
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
  } else {
    elements.localAddress.textContent = 'localhost:9834';
    elements.localDetail.textContent = '请在终端运行 termdock 启动本机服务';
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
