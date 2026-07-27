# 微信本地助手

本地助手用于在用户自己的电脑上运行微信自动回复：电脑开着时，每隔几秒轮询微信消息，读取小手机同步到 Supabase 的运行包，调用角色绑定的模型 API 回复，并把微信消息与回复写回 Supabase。

## 使用步骤

1. 在小手机的数据管理里配置 Supabase 云端备份。
2. 在小手机微信设置里点击“下载本地助手包”。
3. 解压压缩包，双击 `启动助手.bat`。

开发调试时，也可以在项目根目录运行：

```bash
node tools/weixin-local-assistant/assistant.mjs
```

只测试一次：

```bash
node tools/weixin-local-assistant/assistant.mjs --once
```

更快轮询：

```bash
node tools/weixin-local-assistant/assistant.mjs --interval 3
```

## 注意

- `config.txt` 包含用户自己的 Supabase service_role key，等同私密密钥，不要公开。
- 电脑关机、脚本关闭、网络断开时不会继续自动回复。
- 角色、API、预设、世界书或记忆改动后，需要重新在小手机里下载本地助手包或同步运行包。
- 目前文本消息会复用小手机的状态清理和分段策略；图片、语音、文件上传发送能力已预留在本地脚本中，但聊天协议卡片渲染仍会先降级成文本。
