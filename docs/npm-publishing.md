# npm Trusted Publishing

Termdock 的 npm 发布使用 GitHub 托管的 Actions runner 和 OIDC 临时身份，不需要保存 `NPM_TOKEN`。工作流只允许从 `master` 手动触发，并要求输入与已提交 `package.json` / lockfile 一致的版本。

## 首次绑定

账号所有者登录 npm 后，打开 <https://www.npmjs.com/package/termdock/access>，在 **Trusted publishing** 中添加 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Jovines` |
| Repository | `termdock` |
| Workflow filename | `npm-publish.yml` |
| Environment name | 留空 |
| Allowed actions | 启用直接 `npm publish` |

这是 npm 端的首次授权，不能仅凭 GitHub 仓库权限代替。首次绑定后需在 npm 规定的有效期内成功发布；目前官方要求 2 天内完成首次发布。

## 验证与发布

在 GitHub Actions 的 **Publish npm package** 选择 `master`、填写版本号：

- `publish=false`：安装依赖、运行复制和加密传输回归、完整构建并保存 npm 包，不发布。
- `publish=true`：完成同样的验证后，单独的发布任务取得 OIDC 身份，将构建任务生成且通过 SHA-512 校验的包发布到 npm，并核对 registry integrity 和 `latest` 标签。

CLI 示例：

```sh
gh workflow run npm-publish.yml --ref master -f version=1.4.324 -F publish=false
# npm 端首次绑定完成后：
gh workflow run npm-publish.yml --ref master -f version=1.4.324 -F publish=true
```

版本号应替换为当前已提交且尚未发布的版本。工作流不自动改版本，不发布 Rust Preview，也不会重启任何服务。发布完成后，按项目部署流程更新需要使用新版本的服务。

官方文档：<https://docs.npmjs.com/trusted-publishers/>

## 上传成功与 registry 延迟

`npm publish` 被接受和 registry 公开可查询是两个阶段。发布后最多等待 10 分钟，
匿名查询精确版本，下载公开 tarball 校验 SHA-512，并核对 `latest` 标签。
404、限流、服务端错误和暂时的网络故障会重试。

上传被接受后，npm 的异步处理可能需要几分钟；期间精确版本返回 404、tarball
暂不可下载、`latest` 仍指向上一版，均属于正常的生效等待。先耐心等待并核验同一
版本，不据此判断上传失败、排查凭证、重复发布或另升版本。10 分钟是工作流的
单次自动校验窗口，不是 npm 必须公开的时限；窗口结束后仍可继续核验同一版本。
进度说明应区分「已接受上传」「等待公开」「已校验公开」，避免反复把相同的
等待结果作为异常提醒。

等待窗口结束仍未确认时，工作流保留上传成功结果，并输出 warning、
`registry_state=pending` 和明确的步骤摘要，表示公开可用性尚未验收；
不会因此发送发布失败邮件，也不会自动重复上传。后续应查询同一版本，
不能直接重跑发布或另升版本。已公开且校验通过时输出 `registry_state=verified`。
上传拒绝、非暂时性查询拒绝、版本身份或包完整性不匹配仍使工作流失败。

可下载对应 run 的 `npm-package-VERSION` artifact 后单独核验，无需再次发布：

```sh
node .github/scripts/verify-npm-publication.mjs /path/to/npm-package/pack.json
```

手动核验未传 `--upload-accepted` 时，待生效结果仍返回非零，避免调用方误报公开成功。
