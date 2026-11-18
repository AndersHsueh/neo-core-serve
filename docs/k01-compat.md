# K01：窗口来源与旧融合兼容窄口

本分支堆叠于已验收S1 `8adb19b192f73b0ff53c75edc30812a43e482a19`，不代表S1已合main。源审计固定neo-cli `029a04018576a11c6d4182f39a482df0696ef3a2` /0.4.91，含#53；#64等后续增量待批。

## K01a

五个纯函数既有行为先绿，再实测未知模型fallback错误标known的失败，修为default；tokens仍200000。known表、错误解析和env/config优先级不变。来源类型引用同一WindowSource；不修改协议、PathPolicy、daemon或旧TUI权限。

## K01b构建与唯一维护

仅core维护四个基础函数；一个`@neo/core-compat/compat/v1`受限离线tgz供旧融合过渡，客户端禁止import。源`src/core/contextWindow.ts`是唯一算法住处，`src/compat/v1.d.ts`只有公开DTO声明，类型契约测试校验。归档只含minified JS、声明、package清单、provenance四项，不带源TS/sourcemap/可执行安装脚本/外部依赖/配置。

先提交core源码/构建器形成候选，再用精确Bun1.3.0与候选锁构建；命令`python3 scripts/build-compat.py --candidate <40位SHA> --bun <Bun1.3.0路径> --output dist/neo-core-compat-v1.tgz`。构建总读取候选git对象，并校验正在执行及仓内构建器均匹配候选；临时目录无网络输入。两次干净断网构建归档SHA256相同后，旧侧vendor已构建归档，精确pin并登记配对。归档不嵌其自身digest/未来记录提交SHA，避免双SHA循环。

工具链按版本与二进制SHA256、core锁SHA256、构建参数写provenance。构建器要求1.3.0不等于提高消费者最低版本；归档消费者声明/实测Bun1.1.0与1.3.0，core原有最低1.3不变。旧侧仅保留configuredExplicit与扩展env来源薄适配，不保留基础算法或第二份兜底表。

## 验收与回退

本片核心六测、打包真实契约、两宿主行为对照、旧侧全量测试/PTY、core全闸门原样保留。协议源码/lock/检查器不改。旧侧必须校验archive digest、候选/工具链/锁和pin；篡改应非0。切换前无此依赖的旧版是不可变回滚基线；回退用普通追加revert/整组pin切回，绝不保留活跃双实现。首个pin尚无前一兼容包，不伪造“上一版tgz”回滚；本片不迁移session数据，无服务实机安装。

完整原始证据与实际配对由仓库外K01报告记录。K01a单独通过不称单源迁入完成；必须旧侧委托、消费、全闸门全部通过再交审。后续模型/prompt/Agent cohort未获本单授权。
