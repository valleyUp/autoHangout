# AutoHangout v2.0.0 - Debugger API 版本

## 更新说明

此版本使用 Chrome Debugger API 实现真正的后台滚动功能，即使在标签页最小化或切换到其他标签时也能持续自动浏览。

## 工作原理

1. **Chrome Debugger API**：通过 Chrome DevTools Protocol 附加到目标标签页
2. **Input.dispatchMouseEvent**：模拟真实的鼠标滚轮事件，绕过浏览器对后台标签的节流限制
3. **自动重连**：如果调试器连接断开，会自动尝试重新连接

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

⚠️ **单标签限制**：当前版本一次只对一个 linux.do 标签页使用调试器滚动。切换到新的 linux.do 标签会自动切换调试目标。

## 技术细节

- 使用 `chrome.debugger.attach()` 附加到标签页
- 通过 `Input.dispatchMouseEvent` 发送 `mouseWheel` 事件
- 滚动间隔约 3 秒（通过 Chrome Alarms API 实现）
- 后台服务工作线程保持活跃，持续发送滚动命令

## 分支信息

- 分支名：`feature/debugger-api-background`
- 基于：`main` (v1.1.0)
