Wen's Ding｜macOS 通用测试版

适用电脑：
- Apple 芯片 Mac（M1 / M2 / M3 / M4 等）
- Intel 芯片 Mac

第一次使用：
1. 请先完整解压，不要在压缩包里直接运行。
2. 按住 Control 点击 Start.command，选择“打开”。
3. 若系统仍提示无法验证开发者：先尝试打开一次，再进入“系统设置 → 隐私与安全性”，在安全性区域选择“仍要打开”。公司管控的 Mac 可能需要 IT 协助。
4. 稍等片刻后管理页面会自动出现。
5. 首次启动会载入预设的内容池、三套话术池和星期规则。
6. 录入自己的钉钉机器人 Webhook，先执行测试发送，确认目标群正确，再开启定时发送。

日常使用：
- 双击 Start.command：启动后台并打开管理页面。
- 双击 Stop.command：停止后台。
- 双击 Enable-AutoStart.command：设置登录 Mac 后自动运行。
- 双击 Disable-AutoStart.command：取消自动运行。

重要说明：
- 电脑必须开机、联网，并且用户保持登录，定时提醒才能发送。
- 页面关闭后，后台仍会继续运行。
- 每位用户的数据彼此独立，只保存在自己的 Mac 中。
- Webhook 和加签密钥会使用 macOS 钥匙串中的本机密钥加密，数据库不保存明文。
- 不要把自己的数据文件或钥匙串密钥发给其他人。
- 分发包不含制作者的机器人、Webhook、提醒、发送记录；只保留预设内容池、话术池和星期规则。

数据位置：
~/Library/Application Support/WensDing/data/reminders.db

测试版说明：
本包已在 Windows 构建环境中校验两种 Mac 运行核心、初始数据库和跨平台逻辑，但仍需在真实 Mac 上完成最终双击运行确认。若启动失败，请把下面的日志文件发给维护者（日志不会记录 Webhook 明文）：
~/Library/Application Support/WensDing/backend.log
