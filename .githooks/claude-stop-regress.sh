#!/bin/sh
#
# Claude Code 的 Stop 钩子 —— agent 一轮结束时, 如果它动过 src/engine 或
# src/meta 而基线没跟上, 当场把差异摆出来。
#
# 和 .githooks/pre-commit 的分工: pre-commit 是硬门(拦提交, 谁都绕不过);
# 这个是早期预警 —— agent 往往改完就接着改下一处, 等到提交时才发现漂移,
# 上下文已经翻了好几页。在一轮结束时说, 修起来最便宜。
#
# 只在工作区真有引擎/元进程改动时才跑(约 2.5s), 其余轮次零成本。
# 非阻塞: 只把结论回灌给模型 + 提示用户, 不强行让 agent 继续跑(避免死循环)。

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 没动引擎/元进程 → 静默退出。
git diff HEAD --name-only 2>/dev/null | grep -qE '^src/(engine|meta)/' || exit 0

# 基线已经跟着一起改了 → 说明已经 bless 过, 不用再吵。
if git diff HEAD --name-only 2>/dev/null | grep -q '^tools/baseline/regress.txt'; then
  exit 0
fi

report=$(npm run --silent regress 2>&1) && exit 0

# 只取结论段, 别把 3600 行灌进上下文。
summary=$(printf '%s' "$report" | grep -E '^(⚠️|ℹ️|✗|     [a-z-]+ )' | head -12)

# JSON 转义(仅需处理反斜杠、引号、换行)。
esc=$(printf '%s' "$summary" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')

cat <<EOF
{
  "systemMessage": "回归指纹: 引擎/元进程有未 bless 的行为漂移 (npm run regress 未通过)",
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "本轮改动了 src/engine 或 src/meta, 且 npm run regress 未通过 —— 存在未 bless 的行为漂移:\\n${esc}\\n改动是有意的就跑 npm run regress:bless 并把 tools/baseline/regress.txt 一起提交; 不是有意的就按报告里指出的 profile/层次查因。注意 .githooks/pre-commit 会拦下未 bless 的提交。"
  }
}
EOF
exit 0
