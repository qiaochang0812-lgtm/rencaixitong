# 人才证书与业绩管理系统（安卓版）

把「人才证书与业绩管理系统」做成手机 App：**同一套业务规则和数据模型，界面按手机操作习惯重做**（底部导航、卡片式台账、底部抽屉表单），并额外加了手机能力：

1. **到期本地推送**：合同 / 注册证 / 三类人员证三路到期，分别在前 30 天（预警阈值）、前 7 天、到期当天早上 9 点推送。
2. **导出走系统“保存/分享”**：CSV 台账、JSON 备份在手机上点导出时，弹出系统保存/分享面板（安卓 WebView 里网页下载链接默认不生效）。

技术栈：**Capacitor 6 + Vite**（网页部分直接复用桌面版的原生 JS，不改业务逻辑）。

---

## 一、目录结构

```text
talent-cert-app/
├─ index.html                网页入口（Vite）
├─ package.json
├─ vite.config.js
├─ capacitor.config.json     appId / 应用名 / webDir
├─ .gitignore
├─ public/
│  └─ 导入模板.csv            CSV 导入模板
├─ src/
│  ├─ main.js                入口，按顺序加载下面这些
│  ├─ seed-data.js           空白初始化数据
│  ├─ app.js                 业务逻辑与页面渲染
│  ├─ legacy-migrate.js      旧版加密手机号的一次性迁移（迁移完成后不再使用）
│  ├─ styles.css             手机 App 样式（移动端优先，含安全区）
│  └─ bridge.js              安卓桥接：到期推送 + 导出/分享 + 返回键
└─ .github/workflows/
   └─ extract-and-build.yml  解压 zip → 构建 APK → 成功后提交源码并删除 zip
```

> 界面分三页，底部导航切换：**首页**（看板与预警）、**台账**（卡片列表 + 搜索筛选，中间的 ＋ 是新增记录）、**设置**（预警规则、导入导出与备份、操作日志）。新增/编辑/导入都是底部抽屉；安卓返回键依次关闭抽屉、回到首页、退出应用。

---

## 二、本地预览（浏览器）

```bash
npm install
npm run dev
```

浏览器打开终端里显示的地址（默认 `http://localhost:5173`）。这一步可以快速验证功能和界面，无需安卓环境。

---

## 三、构建安卓 APK

### 方式 A：本机构建（需要 Android Studio / JDK）

```bash
npm install
npm run build          # 生成 dist/
npx cap add android    # 首次生成 android/ 工程
npx cap sync           # 把 dist/ 同步进 android/
```

然后用 Android Studio 打开 `android/` 目录直接运行；或在命令行：

```bash
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

> Windows 下把 `./gradlew` 换成 `gradlew.bat`。

### 方式 B：GitHub Actions 一键构建（推荐）

1. 把 `.github/workflows/extract-and-build.yml` 放进仓库。
2. 把源码 zip 放到仓库**根目录**并推送（或在 Actions 页面手动 Run workflow）。
3. 工作流会：解压源码到仓库 → 构建 APK → 上传 APK → **构建成功后**提交解压出的代码并删除 zip；失败则保留 zip，方便重试。
4. 构建完成后，在当次运行页面的 **Artifacts** 里下载 `talent-cert-debug-apk`。

> 工作流不会用 zip 里的 `.github` 覆盖仓库自己的工作流（默认令牌无权推送工作流文件改动）。首次构建会生成 `package-lock.json` 并一并提交，之后依赖版本即被锁定。

---

## 四、构建前要改的东西

`capacitor.config.json`：

| 字段 | 说明 |
|---|---|
| `appId` | 应用唯一 ID（反向域名，如 `com.yourname.talentcert`）。上架/自用建议改成自己的 |
| `appName` | 桌面图标下的名字，默认「人才证书业绩」 |

**正式发布要签名**：Debug APK 可以直接安装测试，但每次重装会覆盖数据（签名变化时）。正式用请生成自己的签名，参考 Capacitor 官方文档配置 `android/app/build.gradle` 的 signing。

---

## 五、功能说明与注意事项

- **数据保存在手机本机**（WebView 的 localStorage，键名 `talentCertificateSystem.v2`），不会上传；卸载应用或清除数据会丢失，请定期「设置 → 导出备份（JSON）」。
- **首次启动会请求通知权限**，允许后才能收到到期推送；拒绝后不影响其它功能，页面内的到期预警仍然有效。
- **已取消加密与密码系统**：手机号直接保存并可点击拨号，备份文件也是明文 JSON，请妥善保管。操作日志保留最近 1000 条，在「设置」页查看和导出。
- **从旧版升级**：若旧版数据里有加密手机号，启动时会提示输入旧管理密码做一次性转换（也可在「设置 → 迁移旧版加密手机号」里稍后再转）。旧版备份文件同样支持恢复后迁移。
- **CSV 导入导出与桌面版同构**，表头/字段别名一致，可互相迁移：桌面导出的 CSV 能在手机导入，反之亦然。
- Android 14 起「精确闹钟」默认不授权，此时推送会由系统择机触发，可能比早上 9 点略晚；可在系统设置里给应用开启「闹钟和提醒」。
- 预警阈值在「设置」页改，推送会按当前阈值自动重排。

---

## 六、常见问题

**Q：`npx cap add android` 报错？**
先确认 `npm install` 成功、Node 版本 ≥ 18，且已安装 Android Studio / JDK 17。

**Q：装了 APK 后收不到推送？**
到手机「设置 → 应用 → 人才证书业绩 → 通知」里确认通知已开启；部分国产系统还需关闭该应用的省电限制。

**Q：和桌面版数据能自动同步吗？**
不能。两边数据各自本机保存，用「导入/导出 CSV」手动互通。
