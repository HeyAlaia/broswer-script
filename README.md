# 我的油猴脚本仓库

个人自用的 Tampermonkey 脚本，通过 raw 链接安装后可自动检查更新（更新逻辑依赖脚本头部的 `@version`）。

## 脚本列表

### 📖 Clean Reader - 媒体占位 + 阅读模式

拦截图片/视频自动加载，改为右键按需加载；Alt+R 进入 Readability 阅读模式；Alt+S 手动选择正文并按站点记忆。

**[点击安装](https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/clean-reader.user.js)**

### 🚫 搜索结果屏蔽器（Bing + DuckDuckGo）

双层屏蔽 CSDN、百度系等低质量站点：搜索词自动追加 `-site:` 服务端过滤 + 结果页 DOM 隐藏；悬停结果可一键屏蔽任意站点。

**[点击安装](https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/bing-search-blocker.user.js)**

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展；
2. 点击上方"点击安装"链接（先把 `YOUR_USERNAME/YOUR_REPO` 换成本仓库实际地址）；
3. Tampermonkey 会弹出安装页，点"安装"即可。之后扩展会按 `@updateURL` 自动检查更新。

## 更新流程

1. 修改脚本；
2. 头部 `@version` 版本号 +1（Tampermonkey 靠它识别新版本，不升不更新）；
3. `git add . && git commit -m "xxx" && git push`，订阅者在 Tampermonkey 更新周期到达后自动收到新版。

## 注意（国内网络）

- `raw.githubusercontent.com` 在大陆直连经常被污染。如果安装/更新失败：
  - 走代理，或
  - 把安装链接和脚本头部 `@downloadURL`/`@updateURL` 中的域名换成 `cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/...`（jsDelivr 有约 12 小时缓存，急更可去 purge.jsdelivr.net 手动刷新）。
