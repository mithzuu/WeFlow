# WeFlow API 实时监听消息 - 模块依赖分析

## 需求场景
只需要使用 HTTP API 来实时监听微信消息（SSE 推送）

---

## 核心必需模块

### 1. HTTP API 服务层
**文件**: `electron/services/httpService.ts`
**作用**: 提供 HTTP API 接口和 SSE 消息推送
**依赖**:
- `chatService` - 获取消息、会话、联系人
- `wcdbService` - 数据库操作
- `ConfigService` - 配置管理
- `groupAnalyticsService` - 群成员信息（可选，如果不需要群成员接口可移除）
- `snsService` - 朋友圈接口（可选，如果不需要朋友圈接口可移除）
- `videoService` - 视频解密（可选，如果不需要媒体导出可移除）
- `imageDecryptService` - 图片解密（可选，如果不需要媒体导出可移除）

**关键接口**:
```typescript
// 启动 HTTP 服务
await httpService.start(5031, '127.0.0.1')

// SSE 消息推送端点
GET /api/v1/push/messages

// 消息查询接口
GET /api/v1/messages?talker=xxx

// 会话列表
GET /api/v1/sessions

// 联系人列表
GET /api/v1/contacts
```

---

### 2. 消息推送服务
**文件**: `electron/services/messagePushService.ts`
**作用**: 监听数据库变化，实时推送新消息到 SSE 客户端
**依赖**:
- `chatService` - 获取会话和消息
- `wcdbService` - 数据库操作和监听
- `httpService` - 广播消息到 SSE 客户端
- `ConfigService` - 配置管理

**工作流程**:
```
1. 监听数据库 Session 表变化
2. 检测会话的 lastTimestamp 和 unreadCount 变化
3. 获取新消息
4. 过滤掉自己发送的消息
5. 构建推送 payload
6. 通过 httpService.broadcastMessagePush() 推送
```

**关键方法**:
```typescript
messagePushService.start()  // 启动服务
messagePushService.handleDbMonitorChange(type, json)  // 处理数据库变化
```

---

### 3. 聊天服务
**文件**: `electron/services/chatService.ts`
**作用**: 消息、会话、联系人的业务逻辑层
**依赖**:
- `wcdbService` - 数据库操作
- `ConfigService` - 配置管理

**核心功能**:
- `getSessions()` - 获取会话列表
- `getNewMessages(talker, since, limit)` - 获取新消息
- `getContacts()` - 获取联系人
- `getContactAvatar(username)` - 获取头像信息

---

### 4. 数据库服务
**文件**: `electron/services/wcdbService.ts`
**作用**: 微信数据库的底层操作（WCDB 解密和查询）
**依赖**:
- `wcdbCore` - WCDB 核心库（C++ 绑定）
- `ConfigService` - 配置管理
- `dbPathService` - 数据库路径管理

**核心功能**:
- `connect()` - 连接数据库
- `openMessageCursor()` - 打开消息游标
- `fetchMessageBatch()` - 批量获取消息
- `getSessions()` - 获取会话
- `getContacts()` - 获取联系人
- `startDbMonitor()` - 监听数据库变化（关键！）

**数据库监听机制**:
```typescript
// 监听 Session 表变化
wcdbService.startDbMonitor((type, json) => {
  messagePushService.handleDbMonitorChange(type, json)
})
```

---

### 5. 配置服务
**文件**: `electron/services/config.ts`
**作用**: 管理应用配置（数据库路径、密钥、API 设置等）
**依赖**: `electron-store`

**关键配置**:
```typescript
{
  dbPath: string,              // 微信数据库路径
  decryptKey: string,          // 数据库解密密钥
  myWxid: string,              // 当前用户微信ID
  httpApiEnabled: boolean,     // HTTP API 开关
  httpApiPort: number,         // API 端口
  httpApiToken: string,        // API 访问令牌
  messagePushEnabled: boolean  // 消息推送开关
}
```

---

### 6. 数据库路径服务
**文件**: `electron/services/dbPathService.ts`
**作用**: 自动检测和管理微信数据库路径
**依赖**: 无

---

### 7. WCDB 核心
**文件**: `electron/services/wcdbCore.ts`
**作用**: WCDB 数据库的 C++ 绑定（通过 koffi FFI）
**依赖**: `koffi` (FFI 库)

**关键功能**:
- 加载 WCDB 动态库（Windows: wcdb_api.dll, macOS: libwcdb_api.dylib, Linux: libwcdb_api.so）
- 提供数据库解密和查询的底层接口

---

## 可选模块（根据需求决定）

### 8. 群组分析服务（如需群成员接口）
**文件**: `electron/services/groupAnalyticsService.ts`
**作用**: 群成员信息和统计
**API**: `GET /api/v1/group-members`

### 9. 朋友圈服务（如需朋友圈接口）
**文件**: `electron/services/snsService.ts`
**作用**: 朋友圈时间线、媒体解密
**API**: `GET /api/v1/sns/timeline`

### 10. 图片解密服务（如需媒体导出）
**文件**: `electron/services/imageDecryptService.ts`
**作用**: 解密聊天中的图片
**依赖**: `wcdbCore`, `ConfigService`

### 11. 视频服务（如需视频导出）
**文件**: `electron/services/videoService.ts`
**作用**: 解密和处理视频文件
**依赖**: `ffmpeg-static`, `ConfigService`

---

## 完全不需要的模块

### UI 相关
- ❌ `src/` 整个前端目录（React UI）
- ❌ `electron/windows/` 窗口管理
- ❌ `public/` 静态资源

### 分析和报告
- ❌ `electron/services/analyticsService.ts` - 私聊分析
- ❌ `electron/services/annualReportService.ts` - 年度报告
- ❌ `electron/services/dualReportService.ts` - 双人报告
- ❌ `electron/annualReportWorker.ts` - 年度报告 Worker
- ❌ `electron/dualReportWorker.ts` - 双人报告 Worker

### 导出功能
- ❌ `electron/services/exportService.ts` - 消息导出
- ❌ `electron/services/contactExportService.ts` - 联系人导出
- ❌ `electron/services/exportCardDiagnosticsService.ts` - 导出诊断
- ❌ `electron/exportWorker.ts` - 导出 Worker

### 其他功能
- ❌ `electron/services/voiceTranscribeService.ts` - 语音转写
- ❌ `electron/services/imagePreloadService.ts` - 图片预加载
- ❌ `electron/services/imageSearchWorker.ts` - 图片搜索
- ❌ `electron/services/keyService.ts` - 密钥管理（Windows Hello）
- ❌ `electron/services/windowsHelloService.ts` - Windows Hello
- ❌ `electron/services/cloudControlService.ts` - 云控制
- ❌ `electron/services/bizService.ts` - 业务服务
- ❌ `electron/services/wasmService.ts` - WASM 服务（除非需要朋友圈视频解密）
- ❌ `electron/services/isaac64.ts` - ISAAC64 算法（除非需要朋友圈解密）

---

## 最小化依赖树

```
main.ts (简化版)
├── ConfigService
├── dbPathService
├── wcdbCore
├── wcdbService
│   ├── wcdbCore
│   ├── ConfigService
│   └── dbPathService
├── chatService
│   ├── wcdbService
│   └── ConfigService
├── messagePushService
│   ├── chatService
│   ├── wcdbService
│   ├── httpService
│   └── ConfigService
└── httpService
    ├── chatService
    ├── wcdbService
    └── ConfigService
```

---

## 启动流程（最小化版本）

```typescript
// 1. 初始化配置
const configService = new ConfigService()

// 2. 连接数据库
await wcdbService.connect()

// 3. 启动数据库监听
wcdbService.startDbMonitor((type, json) => {
  messagePushService.handleDbMonitorChange(type, json)
})

// 4. 启动消息推送服务
messagePushService.start()

// 5. 启动 HTTP API 服务
await httpService.start(5031, '127.0.0.1')

// 完成！现在可以通过以下方式监听消息：
// curl -N "http://127.0.0.1:5031/api/v1/push/messages?access_token=YOUR_TOKEN"
```

---

## API 使用示例

### 1. 实时监听消息（SSE）
```bash
curl -N "http://127.0.0.1:5031/api/v1/push/messages?access_token=YOUR_TOKEN"
```

**响应示例**:
```
event: ready
data: {"success":true,"stream":"http://127.0.0.1:5031/api/v1/push/messages"}

event: message.new
data: {"event":"message.new","sessionId":"wxid_xxx","messageKey":"server:123:456:789","sourceName":"张三","content":"你好"}

event: message.new
data: {"event":"message.new","sessionId":"xxx@chatroom","messageKey":"server:123:456:790","groupName":"项目群","sourceName":"李四","content":"[图片]"}
```

### 2. 查询历史消息
```bash
curl "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&limit=20" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 3. 获取会话列表
```bash
curl "http://127.0.0.1:5031/api/v1/sessions" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 资源文件需求

### 必需的动态库
- **Windows**: `resources/wcdb_api.dll` (x64) 或 `resources/arm64/wcdb_api.dll` (ARM64)
- **macOS**: `resources/libwcdb_api.dylib`
- **Linux**: `resources/libwcdb_api.so`

### 不需要的资源
- ❌ `public/assets/` - 表情包资源
- ❌ `electron/assets/wasm/` - WASM 模块（除非需要朋友圈）
- ❌ `resources/icon.*` - 图标文件
- ❌ FFmpeg 相关文件

---

## 配置文件精简

### package.json 依赖精简
**保留**:
```json
{
  "dependencies": {
    "electron-store": "^11.0.2",
    "koffi": "^2.9.0"
  },
  "devDependencies": {
    "electron": "^41.1.1",
    "typescript": "^6.0.2"
  }
}
```

**可移除**:
- `react`, `react-dom`, `react-router-dom` - UI 框架
- `echarts`, `echarts-for-react` - 图表
- `exceljs`, `jszip` - 导出功能
- `ffmpeg-static` - 视频处理
- `sherpa-onnx-node` - 语音转写
- `html2canvas` - 截图
- `jieba-wasm` - 分词
- `silk-wasm` - 语音解码
- `vite`, `@vitejs/plugin-react` - 前端构建工具

---

## 总结

### 核心模块（7个）
1. ✅ `ConfigService` - 配置管理
2. ✅ `dbPathService` - 数据库路径
3. ✅ `wcdbCore` - WCDB 核心
4. ✅ `wcdbService` - 数据库服务
5. ✅ `chatService` - 聊天服务
6. ✅ `messagePushService` - 消息推送
7. ✅ `httpService` - HTTP API

### 可选模块（根据需求）
- `groupAnalyticsService` - 如需群成员接口
- `snsService` - 如需朋友圈接口
- `imageDecryptService` - 如需图片解密
- `videoService` - 如需视频解密

### 完全不需要（30+ 个）
- 所有 UI 相关代码
- 所有分析和报告功能
- 所有导出功能
- 语音转写、图片搜索等高级功能

---

## 性能优化建议

1. **移除前端构建**: 不需要 Vite 和 React，可以大幅减少依赖
2. **精简依赖**: 只保留 `electron-store` 和 `koffi`
3. **移除 Worker**: 不需要年度报告、导出等 Worker 线程
4. **简化主进程**: 移除窗口管理、托盘、自动更新等功能
5. **只保留 API**: 可以做成纯后台服务，甚至不需要 Electron，改用 Node.js

---

## 改造为纯 Node.js 服务的可能性

如果不需要 Electron 的桌面功能，可以改造为纯 Node.js 服务：

```
Node.js HTTP Server
├── express/fastify (HTTP 框架)
├── wcdb_api.dll/so/dylib (通过 koffi 调用)
├── ConfigService
├── wcdbService
├── chatService
├── messagePushService
└── httpService
```

**优势**:
- 更轻量（无 Electron 开销）
- 更适合服务器部署
- 更容易容器化（Docker）
- 资源占用更少

**劣势**:
- 需要手动管理配置文件
- 没有 GUI 配置界面
- 需要手动获取数据库路径和密钥
