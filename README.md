# AutoHangout v2.3.2 - Debugger API 版本

## 更新说明

此版本使用 Offscreen tick + 消息驱动滚动（content script）实现后台滚动/跳转：即使 linux.do 标签页最小化或切换到其他标签时也能持续自动浏览。

## 工作原理

1. **单目标标签页**：启动时锁定一个 linux.do tab 作为自动浏览目标，不会因为你切换到其它 linux.do 标签而“劫持”目标
2. **Offscreen tick**：offscreen 页面以固定频率唤醒 service worker，避免后台/最小化时调度停摆
3. **消息驱动滚动**：后台定时下发 `doScroll` 指令，由 content script 在 isolated world 执行 `scrollBy`（不受站点 CSP 影响，也不依赖页面定时器）
4. **Chrome Debugger API 兜底**：当 content script 不可用时，使用 CDP 滚动作为兜底
5. **后台跳转**：由 service worker 通过 `tabs.update` 执行跳转，规避页面计时器在后台被强节流导致的卡死
6. **自动重连**：如果调试器连接断开，会自动尝试重新连接

## 安装步骤

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `autoHangout` 文件夹

## 使用方法

1. 访问 linux.do 论坛
2. 点击扩展图标，启动自动浏览
3. 首次启动时，Chrome 会显示黄色横幅：**"AutoHangout" started debugging this tab**
4. 这是正常现象，表示 Debugger API 已激活
5. 现在可以最小化窗口或切换到其他标签，自动浏览会继续运行

## 注意事项

⚠️ **调试器横幅**：使用 Debugger API 时，Chrome 会在标签页顶部显示黄色提示横幅，这是 Chrome 的安全机制，无法隐藏。

⚠️ **手动取消调试**：如果您点击横幅上的 "Cancel" 按钮，调试器会断开连接。扩展会尝试自动重连，但如果选择 "Cancel" 后 Chrome 不允许重连，需要重新启动扩展。

⚠️ **单标签限制**：当前版本一次只对一个 linux.do 标签页执行自动浏览。切换到新的 linux.do 标签不会自动切换调试目标（需你在新 tab 上手动重新点一次“开始浏览”）。

## 技术细节

- 使用 `chrome.debugger.attach()` 附加到标签页
- 优先用消息驱动滚动（content script 执行 `scrollBy`）
- 必要时使用 Debugger API 兜底滚动
- 滚动间隔约 3 秒（Offscreen tick / Alarms 双通道，自动去重）
- 后台 service worker 维持活跃并持续发送滚动/跳转命令

## 分支信息

- 分支名：`feature/debugger-api-background`
- 基于：`main` (v1.1.0)
