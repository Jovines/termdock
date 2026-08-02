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
  form: document.querySelector('#connection-form'),
  url: document.querySelector('#connection-url'),
  label: document.querySelector('#connection-label'),
  save: document.querySelector('#save-connection'),
  connections: document.querySelector('#connections'),
  connectionCount: document.querySelector('#connection-count'),
  version: document.querySelector('#version'),
};

let currentSnapshot = null;

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

function renderConnections(connections) {
  elements.connections.replaceChildren();
  if (connections.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '暂无已保存连接';
    elements.connections.append(empty);
    return;
  }
  for (const connection of connections) {
    const row = document.createElement('div');
    row.className = 'connection-row';

    const copy = document.createElement('div');
    copy.className = 'connection-copy';
    const name = document.createElement('strong');
    name.textContent = connection.label;
    const url = document.createElement('span');
    url.textContent = connection.url;
    copy.append(name, url);

    const actions = document.createElement('div');
    actions.className = 'connection-actions';
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.textContent = '连接';
    connect.addEventListener('click', () => {
      void busy(connect, async () => {
        const result = await api.connect(connection.url);
        if (!result.ok) showNotice(result.error || '连接失败', true);
      });
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      void busy(remove, async () => {
        currentSnapshot = await api.removeConnection(connection.id);
        render(currentSnapshot);
      });
    });
    actions.append(connect, remove);
    row.append(copy, actions);
    elements.connections.append(row);
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

  renderConnections(snapshot.connections);
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

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const button = document.querySelector('#probe-connection');
  void busy(button, async () => {
    const result = await api.probe(elements.url.value);
    if (!result.ok) {
      showNotice(result.error || '服务检测失败', true);
      return;
    }
    currentSnapshot = await api.saveConnection(result.url, elements.label.value);
    render(currentSnapshot);
    await api.connect(result.url);
  });
});

elements.save.addEventListener('click', () => {
  void busy(elements.save, async () => {
    currentSnapshot = await api.saveConnection(elements.url.value, elements.label.value);
    render(currentSnapshot);
    showNotice('连接已保存。');
  });
});

void refresh().catch((error) => {
  showNotice(error instanceof Error ? error.message : String(error), true);
});
