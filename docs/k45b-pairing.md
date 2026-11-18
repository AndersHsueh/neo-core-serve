# K45b 候选、归档与旧侧 pin 配对记录

本记录提交晚于构建候选及旧侧 pin；不进入归档，不在归档里嵌自身或未来记录 SHA，因此没有双 SHA 循环。仅记录本波纯叶配对，不开始 K45c，不把叶导出说成 runtime 已切换。

| 项 | 固定值 |
|---|---|
| core 堆叠底座 | `670771e7c89599c692c73d9907acae3128de398a`（波次 3 已合入 main，版本 0.0.2，无新 tag） |
| neo-cli 堆叠底座 | `a7b237e8ec71e67cf0caeb1af9e934a2fd421729` / v0.4.94 |
| core 构建候选 | `1eaea68b34ae16a8c93c9eff9368def6488e4b98` |
| 归档 | 仍是一个 `@neo/core-compat/compat/v1`，16962 字节，无外部依赖 |
| 归档 SHA256 | `38eade64023d5cba7e4f9154c955e9b6354cdbf91844c766413c695e5002e41c`（旧 K01 归档为 `6942996c08baaeedec00cce82091116a46877c7f22810c0917f348fc4d2258e4`） |
| 构建 Bun | 1.3.0，Linux x64，二进制 `70ce58104a5d2a81b254f5b5c77bbd890dcdb1ef3499c554472f6625199e1df9` |
| core 锁 SHA256 | `5dce79b4509e79e3e0f17a20912f162b17a05be4337ed2915b9396fd2cfd225a`（与 K01 相同，本波未改 bun.lock） |
| 入口 | `src/compat/v1.ts`，SHA256 `2a66230fa7c866230eff0bc8d2f76872d557ef7f0bcee449c4e03f742da8580f` |
| 声明 SHA256 | `72f6852736588ebf53a148643cbe8999b214717945dc48b32d96fa81fefc0b5b` |
| index.js SHA256 | `89fe060f52696a916aa81ed77adbd1224e1f1dfe782d8376ce5c5deb35db7b7b` |
| 旧侧 pin 提交 | 见 neo-cli `neo/mpa-wave4` 日志 / 外部报告 |
| 协议 lock SHA256 | `108df3c4204d37a8ecae2b4c808b035733f346bd13cd954dcf058b4f2458bb35`，协议源码/检查器不动 |

顺序是 core 候选 → 两次干净断网构建同 digest → 旧侧 vendor/pin → 此记录。仍只用一个 compat/v1 离线 tgz+pin。已晋升纯叶只在 core 维护；旧侧对纯叶做薄适配，Agent 循环级（K12/K14/K06b/K09b）只登 core 候选，未删旧实现。客户端不得引用过渡包。`src/config.ts` 未增加代码。版本仍是 core 0.0.2、neo-cli 0.4.94。

完整闸门数字、两次构建证据、符号清单与必须保留的披露见仓库外波次 4 报告。
