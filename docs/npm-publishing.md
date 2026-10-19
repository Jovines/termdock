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
