# UkemiXR Splat Walk（网页端）

在浏览器里打开任意 `.spz` / `.ply` 高斯场景，用 Unity 那套 locomotion 在里面走，戴上头显直接进 VR。

页面结构：

- 网站界面全部是英文，面向 PC 端的客户和投资人：讲「为什么值得付费」，不讲技术（本文档给团队看，仍用中文）。
- **联系方式**：`src/site.js` 里填 `contactEmail` 或 `contactUrl` 后，「Book a capture / Get in touch」按钮才会出现。
- **首页**：实时渲染的场景做背景（缓慢的镜头漂移）；主张「Walk any real place, from a link」、
  Demo 场景画廊、四个付费理由、六个行业、三步合作流程（我们扫描 → 我们搭建 → 你分享链接）。
  按 WASD 或点 **Walk the demo** 直接进入行走。
- **行走模式**：第一人称 / 第三人称 locomotion、场景切换、导入、设置面板、操作说明。
- **展示模式**：导入的模型没有足够大的地面（一尊雕像、一张沙发）时自动切换，拖拽环绕、滚轮缩放。
- **VR**：头显内菜单（左手 X / Y 打开，射线 + 扳机选择）可以直接切换场景、回到出生点、退出；
  手柄有模型和射线，手柄上常驻操作说明；右手 **A** 切换走路时的镜头（Steady cuts ↔ 第一人称跟随）；
  房间尺度下头伸进墙里会淡黑。
- **自动演示模式（Auto demo，展会用）**：首页 **Auto demo**、行走模式顶栏按钮、VR 菜单，或 `?demo`。
  - 角色按**固定路线**自己走：场景加载后从出生点用碰撞体推演一次（前方探测找空地 + 缓慢 S 形转弯），
    存成每 1/30 s 一个采样点；运行时每帧把摇杆设成正好走到下一个采样点，所以每次走的是同一条线。
  - 走走停停：走 1.7 s → 停 1.0 s → 走 1.5 s → 停 1.1 s → …（`WALK_PATTERN`）。每次起步、停下都是两种镜头差别最大的时刻：
    ON 停下时镜头切回人物头里、起步时让人物走出去；OFF 只是跟着一起顿、一起冲。
  - 8 s **ON**（绿色，Steady cuts）走一遍 → 传送回出生点 → 5 s **OFF**（红色，普通第一人称，
    视角随行走连续平移 + 转向）走同一条路线的前段 → 传送回去，循环。同一条路线对比，差别更直观。
  - 网页顶部横幅和头显里的头锁徽章只显示 **ON / OFF** 和 **Ukemi Comfort Tech**，没有别的文字。
  - **任意键退出演示**（键盘、鼠标点击、触摸、滚轮，VR 里任意手柄按键或推摇杆；接管的那一下不会触发按键本身的功能），
    **10 s 没有操作自动回到演示**，从 ON 重新开始。顶栏 / 菜单里的 Stop auto demo 才是彻底关闭。
  - **换人自动重开**：网页 WebXR 读不到 proximity sensor，只能看到它的效果：没人戴时系统熄屏、XR session 变成 `hidden`
    并停帧；有人凑近时亮屏、session 变回 `visible`。session 变回可见、或渲染中断 > 1.5 s 后恢复，都从 ON 重新开始。
    所以头显的 proximity sensor **必须开着**（MQDH 里不要禁用）。为了不睡眠 / 不弹账户选择：头显只留一个账户、关访客模式和锁屏，
    自动睡眠调到最长，插电时可用 `adb shell svc power stayon true`。
  - 现场排查：`?weardebug` 让头显里的徽章底行显示当前 session 状态和最近一次重开是哪个信号触发的（如 `session visible, 3 s ago`）。

```
打开 .spz/.ply（示例 / 文件 / 拖放 / ?url=）
  → Spark 渲染（three.js，World Labs 出品，Marble 用的就是它）
  → 从 splat 现场体素化出碰撞体（50 万点约 0.5–1 s）
  → 找出生点（主地面层上离原点最近的空地）
  → locomotion：第一人称站立 / 推摇杆第三人称行走、镜头瞬移追赶
  → Enter VR：WebXR immersive-vr，local-floor
```

## 本地运行

```bash
npm ci
npm run dev          # http://127.0.0.1:5173
```

URL 参数：

| 参数 | 作用 |
|------|------|
| `?scene=living-room` / `bamboo-courtyard` / `trogir` | 打开示例 |
| `?url=https://…/x.spz` | 打开任意远程文件（需对方允许跨域） |
| `?flip=1` | 上下翻转（原版 3DGS 训练出来的 PLY 通常是 Y 朝下） |
| `?debug` | 显示碰撞体素 |
| `?xremu` | 注入模拟 Quest 3（Meta IWER），没有头显也能走一遍 VR 流程 |
| `?walk` | 跳过首页，加载完直接进入行走 |
| `?avatar=soldier` | 换成 Soldier 角色（默认 X Bot） |

### 在 Quest 上本地试（不部署）

WebXR 要求 HTTPS 或 `localhost`。最简单的是 USB 连上 Quest，用 adb 把端口反向转发，头显里访问 localhost：

```bash
npm run dev                         # 电脑上
adb reverse tcp:5173 tcp:5173       # Quest 开发者模式 + USB
# Quest 浏览器打开 http://localhost:5173 → Enter VR
```

## 部署到 Vercel

本仓库根目录自带 `vercel.json`，导入即用：

1. Vercel → **Add New… → Project** → 选 `jinda-li/UkemiXRWeb`。
2. Framework 自动识别为 Vite，Root Directory 留空。
3. Deploy。之后每次 push：非生产分支得到 Preview 链接，`main` 得到正式域名。

WebXR 只在 HTTPS 下可用，Vercel 的域名天然满足。注意 `*.vercel.app` 在中国大陆经常无法访问，
给国内投资人看需要绑定自己的域名。部署产物约 23 MB（两个 `.spz` 示例 + 3.3 MB JS 等）；
Trogir 的流式分块留在仓库里、构建时不进 `dist/`，运行时从 GitHub raw 拉取（见下节「部署」）。
`.ply` 示例体积大（32 MB/个）且内容与 `.spz` 相同，不进仓库，只在本地 dev 里列出（相关测试会自动跳过）。

## 大场景：Trogir 老城（流式加载）

第三个示例是 [superspl.at 上的 Trogir 老城](https://superspl.at/scene/14bac5b2)（Paolo Tosolini，CC BY 4.0，
署名写在示例卡片和场景信息里，**不能去掉**）。它和另外两个示例不是一个量级：

| | 客厅 / 庭院 | Trogir |
|--|--|--|
| splat 数 | ~50 万 | 576 万（原始 2300 万，用的是 superspl.at 第 2 级 LOD，和 Unity 工程一致） |
| 范围 | 一个房间 | 132 × 19 × 161 m 的整条街区 |
| 文件 | 一个 7 MB `.spz` | 130 个 ~1.2 MB 分块，共 158 MB |

整份下载、整份放进显存、在浏览器里体素化都不现实，所以换了两处：

1. **渲染：Spark 2 的流式 LoD**。`build-lod`（Spark 仓库里的 Rust 工具）预先建好 LoD 树，存成分块的
   `.rad`。加载时 `new SplatMesh({ url, paged: true })` 只取索引（14 KB）和最粗的几层，之后按视点
   优先拉近处的细节，显存里常驻的 splat 数有上限（桌面 250 万、Quest 50 万，Spark 按平台自动定）。
   本地实测：1.2 s 可以开始走，桌面 130–140 fps，走一段路下载了约 90 MB。
2. **碰撞：预烘焙**。superspl.at 自己的 walk mode 有一份 splat-transform 生成的体素八叉树
   （`scene.voxel.json/.bin`，0.05 m，已经从街面种子做过连通过滤）。`scripts/voxelToWalkGrid.mjs`
   把它降到 0.1 m，存成 8³ 砖块的稀疏格式（`src/collision/walkGrid.js`：空砖不存、全实心砖只记编号），
   gzip 后 1.5 MB。`VoxelWorld.fromWalkGrid()` 加载后走的是同一套 `moveAndSlide`，只是 `cell()` 换成查砖块。
   整个街巷网都能走到（`tests/walkGrid.test.mjs` 沿 Unity `TrogirWalkProbe` 的路线走一遍）。

坐标：体素在 PlayCanvas 引擎帧（= PLY 绕 Z 转 180°），所以示例里 `frame: 'playcanvas'` 让 splat 也绕 Z 转
180° 显示，和碰撞、和 Unity 场景的数字完全一致；出生点就是 superspl.at viewer 的初始相机。

重新生成（需要 Rust；第一次会 clone Spark 并编译 build-lod，约 4 分钟）：

```bash
npm run import:trogir     # = node scripts/importSuperSplat.mjs 14bac5b2 2 SplatSamples/trogir trogir
```

### 部署：场景分块从 GitHub raw 拉，不进 Vercel

`SplatSamples/*/`（流式场景）在本仓库里，但不打进 Vercel 的部署：158 MB 超过 Hobby 的 100 MB 上传上限，
而且每个访客走一圈要拉 20–90 MB，Vercel 的流量额度（Hobby 每月 100 GB）撑不了多少人。
Vercel 环境变量把 `VITE_SCENE_CDN` 指到本仓库的 raw 地址即可（raw 自带
`Access-Control-Allow-Origin: *`，CORS 无需配置）：

    VITE_SCENE_CDN=https://raw.githubusercontent.com/jinda-li/UkemiXRWeb/main/SplatSamples

设了它，构建就不再拷贝场景目录，页面从这个地址按需取分块。本地不设，照旧走 `/samples`。
raw 不是 CDN，匿名下载有限速——内部 demo 量级够用；对外公开后把同一个文件夹原样迁到
**Cloudflare R2**（出口流量免费，代码不动）：

1. Cloudflare → R2 → 建 bucket（如 `ukemixr-scenes`），**Settings → Custom Domains** 绑一个子域名
   （如 `scenes.你的域名`）。`r2.dev` 的公共地址限速，只适合测试。
2. 同一页 **CORS Policy**：
   ```json
   [{ "AllowedOrigins": ["https://你的网站域名", "https://*.vercel.app", "http://127.0.0.1:5173"],
      "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Length"], "MaxAgeSeconds": 86400 }]
   ```
3. 上传（先 `npx wrangler login`）：`node scripts/uploadScene.mjs ukemixr-scenes SplatSamples/trogir`
4. 把 Vercel 的 `VITE_SCENE_CDN` 改成 `https://scenes.你的域名`，重新部署。

换别的 superspl.at 场景：同一条命令换场景 id，然后在 `src/samples.js` 里照 Trogir 加一项
（`paged` / `collision` / `frame` / `spawn`，脚本最后会打印 spawn），并写上作者署名。

## 四个问题的答案

### 1. 碰撞怎么简单生成？

`src/collision/VoxelWorld.js`，加载时在浏览器里现算，不需要任何离线步骤：

- 每个 splat 按不透明度累加到一张稠密体素网格（默认 10 cm，场景太大时自动放大到 ≤ 2400 万格）。
  大 splat 沿它最长的两个轴采样多点，保证一片大地板 splat 能盖住它画出来的那块地。
- 累计不透明度 ≥ 阈值（默认 1.0，设置里可调）才算实心 —— 零星飞点自然被滤掉。
- 包围盒按 0.4% / 99.6% 分位数取，远处飞点不会把网格撑爆。
- 同时建一张 ~0.3 m 的粗网格，专门处理生成场景里「门洞后面」那种稀疏区域：只用来把地面在**同一高度**延续下去，
  以及在细网格完全没东西的地方挡住稀疏的墙。它不会让人爬高，也不会让家具之间的通道变窄。
- 玩家是一根圆柱（半径 0.22 m，高 1.7 m），和 CharacterController 一样：
  - **脚下**：在「上一步台阶 0.35 m / 下一步 0.6 m」范围内找地面，5 个采样点至少 2 个踩到才算有地。
    **没有地 = 洞或者场景边缘 → 拒绝移动**，这就是「不能走出边界」。
  - **身体**：台阶高度以上到头顶之间有实心体素 = 撞墙。单步台阶 0.25 m，椅子和沙发座面（~0.4 m）高于它，所以会停下。
  - 爬升按最近 0.45 m 的轨迹累计限制在 0.36 m 以内：楼梯能上，「先踩座椅前横档再上座面」这种上不去。
  - 子步长 < 半个体素，撞墙时按单轴滑动，斜着推墙会贴着墙走。
- 出生点：扫描原点 8 m 内每一列能站的最低面，取出现最多的高度当「主地面」，
  再选离原点最近、四周 0.5 m 都能站的点。竹林庭院原点下面是水池，靠这个避开。

Unity 那边的做法（`splat-transform` 体素化 → `.collision.glb` → MeshCollider）精度更高但要离线跑；
网页端面对的是用户随手拖进来的任意文件，所以换成了现场体素化，思路相同（都是体素 + 连通地面）。

### 2. 网页端怎么渲染？

[Spark](https://sparkjs.dev)（`@sparkjsdev/spark`，MIT）：three.js 的高斯渲染器，World Labs 做的，
Marble 自己也在用。支持 `.spz` `.ply`（含压缩 PLY）`.splat` `.ksplat` `.sog`，
能和普通网格混合排序（所以机器人 avatar 可以正常站在 splat 场景里），也处理 WebXR 双目。

### 3. 网页端 XR

直接用 WebXR：`immersive-vr` + `local-floor`，three.js 的 `renderer.xr` 管会话，
相机挂在 `rig`（= Unity 的 XR Origin）下面，头显位姿由设备写，locomotion 只移动 `rig`。
帧缓冲缩放默认 0.75（设置存在 `localStorage` 的 `xrScale`）。
**还没在真机上测过帧率** —— 自动化测试用的是模拟头显，见下文「测试」。

在 Quest / Pico 浏览器打开网址 → 点 **Enter VR**。电脑没头显时按钮是灰的，悬停有说明。

### 4. Unity 的 locomotion 怎么迁移过来

逐文件移植，参数默认值与 Unity 预制体（`VR Player Locomotion.prefab`）里的序列化值一致：

| Unity | Web | 说明 |
|-------|-----|------|
| `VRPlayerControllerInput.cs` | `src/locomotion/PlayerInput.js` | 同样的缓冲边沿 + 迟滞阈值（移动 0.20/0.15，转向 0.75/0.50） |
| `VRCameraRigController.cs` | `src/locomotion/CameraRig.js` | 瞬移追赶、环绕半径 2.5 m、追赶间隔 1 s、35° 转向、起步推镜（侧移后退 1 m、后退 2 m）、环绕防穿墙 |
| `PlayerController.cs` | `src/locomotion/PlayerController.js` | Idle / Locomotion 两态、视线相对移动 2.5 m/s、room-scale 头动带身体 |
| CharacterController + MeshCollider | `src/collision/VoxelWorld.js` | `moveAndSlide` ≈ `CharacterController.Move` |
| VRIK + 人形角色 | `src/avatar/Avatar.js` | Mixamo 人形（three.js 示例里的 X Bot，`?avatar=soldier` 可换 Soldier），Idle/Walk/Run 按实际速度混合，步频跟地速匹配 |
| （Unity Input System） | `src/locomotion/InputSources.js` | WebXR 手柄、键盘、鼠标、手柄、手机触摸 |

防晕的核心没有变：**走路时镜头从不连续移动、从不自己转**。人物往前走，镜头原地不动，
每 1 s 切到人物身后 2.5 m；人物朝镜头走过来（< 1 m）时立刻往后跳；松开摇杆，镜头瞬移回人物头里。
没有连续的视觉流动就没有 vection，也就不晕。

和 Unity 的差异（都是有意的）：

- **回到第一人称时保持当前朝向**。Unity 会把视角转到 avatar 头的朝向（VRIK 的头本来就看着你看的方向，
  所以几乎不转）；这里机器人是面朝行走方向的，照搬会多一次没人要的转向。`CameraRig.keepYawOnReturn` 可关。
- **起步推镜也做了防穿墙**（Unity 只对环绕做了射线检测），贴墙起步不会把镜头推进墙里。
- **后跳距离取 min(2 m, 剩余距离)**，避免离目标很近时来回过冲。
- **贴墙时不再每帧后跳**：Unity 的「角色离镜头 < 1 m 就后跳」在墙边会每帧触发（环绕点被墙截到 1 m 以内），
  镜头就变成连续滑动——恰恰是这套系统要避免的。这里阈值随墙允许的环绕距离缩小，并且任意两次切换至少间隔 0.2 s。
- **走路镜头只有两种**（设置 → Camera → While walking，VR 里右手 A 切换）：**Steady cuts**（上面这套，默认）和
  **First person**（走路时视角一直在人物头里、每帧跟着走，人物隐藏；快转原地转）。旧版本的 auto / smooth 设置读取时回落到 Steady cuts。
- Dodge roll（B 键翻滚）依赖 Mecanim 动画根运动，没有移植；按键缓冲已在 `PlayerInput` 里留好。

## 测试

```bash
npm run dev &                 # 或 npm run preview（测构建产物，BASE=http://127.0.0.1:4173）
npm test
```

| 脚本 | 测什么 |
|------|--------|
| `tests/collision.test.mjs` | Node 里直接读 PLY，建体素、找出生点、16 个方向各走 30 s，不许出界、不许掉下去 |
| `tests/walkGrid.test.mjs` | 预烘焙砖块格式往返；Trogir 出生点在街面上、沿巷子一路走通、楼房内部站不上去 |
| `tests/reachMap.mjs` | 画俯视图：从出生点能走到哪（绿色）。调碰撞参数时看这个 |
| `tests/e2e.mjs` | 无头 Chromium 驱动真页面：第一人称 ↔ 第三人称、镜头只做离散跳切（间隔 ≥0.2 s）且不自转、撞家具停下、35° 转向、后退不穿脸 |
| `tests/tour.mjs` | 三个场景各走一圈：按碰撞网格规划路径、用摇杆走到 8 个方向最远处；自动找低/中/高三类宽障碍（桌子、座椅沙发、墙柜）正面撞上去必须停在跟前；**每一帧**检查身体不在几何体里、脚在地面上 |
| `tests/floorMap.mjs` | 带 1 m 坐标网格的俯视诊断图：绿=能走到、红=挡身体、蓝=没有地面 |
| `tests/demo.mjs` | `?demo` 固定步长跑 40 s：ON 8 s / OFF 5 s 交替、横幅只有 ON/OFF + Ukemi Comfort Tech、每段从出生点开始且 ON/OFF 走同一条路线、走走停停（ON 停 ≥2 次、OFF ≥1 次）、角色被挡 < 15%、ON 时镜头只跳切不平滑转、OFF 时视角在头里连续移动和转向；任意键退出、10 s 无操作从 ON 恢复 |
| `tests/xr.mjs` | 模拟 Quest 3（IWER）：点 Enter VR、摇杆行走（离散跳切，间隔 ≥0.2 s）、快转、手柄说明、A 切到第一人称跟随（行走时视角在头里）再切回、自动演示里 A 接管（不切镜头）、session hidden → visible 从 ON 重开、X 打开菜单、射线瞄准 + 扳机在 VR 内切换场景、头显穿墙淡黑、退出 VR |
| `tests/upload.mjs` | 通过文件选择框打开 `.ply` / `.spz` |
| `tests/robustness.mjs` | 上下颠倒的 PLY 自动翻正、只有一张沙发的模型进展示模式、坏文件报错且保留当前场景、错误扩展名被拒 |
| `tests/landing.mjs` | 首页各段截图（桌面 / 手机） |
| `tests/screens.mjs` | 渲染截图（SwiftShader 很慢，约 2 分钟） |

## 已知限制 / 下一步

- VR 里导入新文件仍需摘下头显（浏览器的文件选择框不能在沉浸模式里打开）；示例场景和已导入的模型可以在 VR 菜单里切换。
- 碰撞只认「地面 + 身体圆柱」：不能钻桌子底下，也没有天花板/低矮门框检查（身高 1.7 m 以上不查）。
- 尺度假设为米。Marble 导出的是米制；COLMAP 训练的场景尺度随意，需要加一个缩放参数。
- 上下方向：示例场景直接信任 +Y 朝上；用户文件两个方向都生成碰撞体，选「地面上有东西站着」的那个方向
  （倒过来的室内场景也能站——站在天花板上——所以不能只看能不能站）。仍不对就在设置里点 **Flip upside down**。
- Trogir 的 e2e 有一项不过：在窄巷里斜着往后退，墙把环绕点截到很近，头像会离镜头 0.2 m 左右
  （另外两个场景 15/15）。这是镜头系统在窄空间里的边界情况，不是加载的问题。
- Spark 的分页器偶尔在第一帧前报一次 `texture not found`（分块比显存纹理先到），之后正常，不影响显示。
- 可以加载 Unity 流程产出的 `.collision.glb` 替代现场体素化（坐标系差一个绕 Z 180°，见
  UnityGaussianSplatting 仓库的 `docs/workflows/superspl-at-to-unity.md` 第 3 节）。

## 素材

- 示例场景：`SplatSamples/`。客厅和竹林庭院由 Marble 生成；`trogir/` 是
  [Paolo Tosolini 的 Trogir 扫描](https://superspl.at/scene/14bac5b2)（CC BY 4.0，可商用，必须署名）。
- Avatar：X Bot / Soldier，Adobe Mixamo 角色与动画（Mixamo 条款允许在商业项目中免版税使用），取自 three.js 示例。
  Unity 工程里的角色和动画包是付费素材，不能公开发布到网页上，所以网页端没有直接用。
