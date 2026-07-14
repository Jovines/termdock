import type { ChangeWalkthrough } from '../../terminal/api';
import { ChangeWalkthroughPanel } from './ChangeWalkthroughPanel';

const REPO_ROOT = '/tmp/termdock-dag-playground';

const sampleWalkthrough: ChangeWalkthrough = {
  version: 1,
  id: 'dag-playground',
  repoRoot: REPO_ROOT,
  workspaceRoot: REPO_ROOT,
  title: '改动解释升级为可点击导览',
  summary: '这是一页免登录 playground，用真实 ChangeWalkthroughPanel 调 DAG 的节点、边、label 和密度。',
  generatedBy: 'dag-playground',
  injectedAt: Date.now(),
  highlights: [
    { what: '先看总览，再看链路', effect: '读者不用先进入 diff，也能理解整批改动目的。', tag: '理解' },
    { what: '多条链路直接画出来', effect: '分支、汇合、验证路径不再靠 next 文本猜。', tag: '链路' },
    { what: '点击节点跳回证据', effect: '导览和真实 diff 之间形成闭环。', tag: '导航' },
  ],
  nodes: [
    { id: 'export', title: '导出 section 级 diff', kind: 'source', business: 'CLI 把 hunk 拆成多个连续改动 section，并为每个 section 生成稳定 fingerprint。这里故意写长一点，用来验证 DAG 节点是否会按照真实文本高度撑开，而不是被固定高度裁掉。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/server/cli.ts', hunkIndex: 0, sectionIndex: 0 } },
    { id: 'prompt', title: '约束 AI 输出', kind: 'process', business: '提示词要求先写总览，再逐 section 生成解释。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/lib/components/sidebar/RightSidebar.tsx', hunkIndex: 0 } },
    { id: 'store', title: '保存整批导览结构', kind: 'process', business: '服务端把 walkthrough 作为一等数据持久化。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/server/utils/changeAuditStore.ts', hunkIndex: 0 } },
    { id: 'api', title: '前端读取总览', kind: 'api', business: '一次请求拿到 records 和 walkthroughs。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/lib/terminal/api.ts', hunkIndex: 0 } },
    { id: 'panel', title: '渲染 DAG 导览', kind: 'ui', business: '用节点和边表达实现链路，节点可点击。节点内容可能是一两句话，也可能包含较长的业务解释；布局需要先测量 DOM 高度，再重新计算每一行节点的 y 坐标和连线端点。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/lib/components/sidebar/ChangeWalkthroughPanel.tsx', hunkIndex: 0 } },
    { id: 'jump', title: '跳回真实 diff', kind: 'ui', business: '点击节点后定位到文件、hunk 或 section。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/lib/components/sidebar/RightSidebar.tsx', hunkIndex: 1 } },
    { id: 'section', title: '贴近改动展示解释', kind: 'ui', business: 'section 解释跟在对应 diff 块后面，而不是堆在 hunk 顶部。这个节点也故意写得更长，用来观察右侧分支和下方验证节点的连线是否会避让变高后的卡片。', anchor: { repoRoot: REPO_ROOT, filePath: 'src/lib/components/sidebar/DiffViewer.tsx', hunkIndex: 0, sectionIndex: 1 } },
    { id: 'verify', title: '验证导出和注入', kind: 'test', business: '跑 lint、install、health、资源检查和注入自测。' },
  ],
  edges: [
    { from: 'export', to: 'prompt', label: '提供输入', desc: 'sectionFingerprint 让 AI 可以稳定引用。' },
    { from: 'prompt', to: 'store', label: '注入', desc: 'AI payload 写回本地服务。' },
    { from: 'store', to: 'api', label: '读取', desc: '浏览器从服务端拿到导览。' },
    { from: 'api', to: 'panel', label: '渲染', desc: '结构化数据变成导览图。' },
    { from: 'panel', to: 'jump', label: '点击', desc: '节点驱动 diff 定位。' },
    { from: 'jump', to: 'section', label: '定位', desc: '落到对应 section 解释。' },
    { from: 'export', to: 'verify', label: '验证', desc: '导出结构要覆盖 tracked/untracked。' },
    { from: 'section', to: 'verify', label: '回归', desc: '确认展示位置和交互。' },
  ],
  sections: [],
  risks: [
    { title: '边和 label 不能遮住节点主体。' },
    { title: '窄侧栏下横向滚动要可控。' },
  ],
  checks: [
    '在 360px、560px、900px 宽度下截图检查。',
    '确认边的箭头、label 背板和节点层级清楚。',
    '确认节点点击区域和 hover 状态可感知。',
  ],
};

export function DagPlayground() {
  return (
    <div className="min-h-screen bg-background p-5 text-foreground" data-dag-playground>
      <div className="mx-auto max-w-[72rem]">
        <div className="mb-3">
          <h1 className="text-sm font-semibold">DAG Playground</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Auth-free playground for tuning the real ChangeWalkthroughPanel.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="min-w-0">
            <ChangeWalkthroughPanel
              walkthroughs={[sampleWalkthrough]}
              repoRoot={REPO_ROOT}
              onNavigate={(anchor) => {
                console.info('[DagPlayground] navigate', anchor);
              }}
            />
          </div>
          <div className="min-w-0">
            <ChangeWalkthroughPanel
              walkthroughs={[sampleWalkthrough]}
              repoRoot={REPO_ROOT}
              onNavigate={(anchor) => {
                console.info('[DagPlayground] navigate', anchor);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
