# DingDone

DingDone 是一个在本机运行的钉钉 Webhook 定时提醒管理器。

它提供浏览器管理页面，但定时调度、数据保存和钉钉发送都由本地后台完成。关闭网页后，只要电脑保持开机、联网并登录 Windows，后台仍可继续运行。

## 主要功能

- 多机器人与 Webhook 管理
- 一次性、每天和每周提醒
- A/B 内容池与顺序循环
- 称呼、开头和结束语三套话术池
- 星期抽取规则与完整消息预览
- 内容批量录入、排序、删除和指定下一条
- Markdown、变量替换和 @所有人
- 发送记录、运行检查和失败保护
- 加密交接包、导入后暂停和接管确认
- Windows 登录自动运行与异常自动恢复

## Windows 使用方法

普通使用者不需要下载源码。

1. 打开仓库的 [Releases](https://github.com/xuw7524-cmyk/wen-s-ding-/releases)。
2. 下载最新的 `DingDone-版本号-win-x64.zip`。
3. 右键 ZIP，选择“全部解压”。
4. 打开解压后的完整文件夹。
5. 双击 `Start-DingDone.cmd`。

不要直接在 ZIP 压缩包内启动程序。

## 数据位置

Windows 用户数据保存在：

```text
%LOCALAPPDATA%\DingTalkReminderManager
```

更新程序包不会覆盖这里的机器人、提醒、内容池和发送记录。

## 安全说明

- Webhook 和签名密钥使用当前 Windows 用户加密保护。
- 页面和日志不会显示完整 Webhook。
- 正式分发包不包含制作者的机器人、Webhook、提醒或发送记录。
- 初次启动时真实发送默认关闭。

## 开发验证

```powershell
npm run release:check
```

当前正式版本：`0.6.0`
