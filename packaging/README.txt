Wen's Ding｜钉钉提醒管家（公司内便携版）

1. 请先把整个文件夹解压出来，不要直接在压缩包内运行。
2. 双击 Start.vbs。
3. 稍等片刻，浏览器会打开 http://127.0.0.1:4173/。
4. 首次启动会自动载入预设的内容池、三套话术池和星期规则。
5. 每位用户录入自己的钉钉机器人 Webhook；配置和记录只保存在当前 Windows 用户目录。
6. 先完成“测试发送”，确认目标群正确，再启用真实定时发送。
7. 电脑必须开机、联网并保持 Windows 用户登录，后台才能按时发送。

可选：
- 右键 Enable-AutoStart.ps1，选择“使用 PowerShell 运行”，设置登录后自动启动。
- 右键 Disable-AutoStart.ps1，选择“使用 PowerShell 运行”，取消自动启动。
- 右键 Stop.ps1，选择“使用 PowerShell 运行”，关闭后台。

补充说明：
- 重复双击 Start.vbs 不会重复启动后台。
- 登录自启动只启动后台，不会自动弹出浏览器；需要管理时再双击 Start.vbs。

数据位置：
%LOCALAPPDATA%\DingTalkReminderManager\data\reminders.db

安全说明：
- Webhook 和加签密钥使用当前 Windows 用户加密保护。
- 不要把自己的数据库文件复制给其他人。
- 分发包不包含制作者的机器人、Webhook、提醒任务或发送历史。
- 每位 Windows 用户第一次启动时都会得到独立数据库；不会与其他同事共享配置。
