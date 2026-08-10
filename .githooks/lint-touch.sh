#!/bin/sh
#
# 移动端事件门 —— 拒绝 onTouch*/onMouse* 手势 prop, 强制 Pointer Events 同构。
#
# 为什么要有这个门: AGENTS.md 约定手势用 Pointer Events (Sheet 的下滑关闭、
# 顶栏外部点击关闭已是正解), 但文档拦不住任何人。onTouch*/onMouse* 做手势会
# 双触发 (同时绑 touch+click) 或漏掉另一类指针 (鼠标 / 手写笔), 而 Pointer
# Events (onPointerDown/Move/Up/Cancel + setPointerCapture + e.pointerType) 是
# W3C 标准里打通三类指针的那一层, React 19 原生支持, 全浏览器 ≥97%。onClick
# 在 <button> 上触摸设备只合成一次, 不会双触发。这个门把"以后不会再犯"从
# 口头约定变成可执行检查。
#
# 触发: npm run lint (含 lint:touch) ; pre-commit 在暂存区有 src/ 改动时也跑。
# 绕过: 改源码用 Pointer Events; 真要跳过是 git commit --no-verify。
#
# 只禁手势类 (Start/End/Move/Cancel/Down/Up/Move), 不禁 hover 类
# (Enter/Leave/Over/Out) —— 桌面端 tooltip / 高亮的 hover 反馈是合法的, 移动端
# 无害。注释行 (// / * / /* 开头) 跳过, 允许在文档里写这些词。
#
# 安装: 本仓库已 git config core.hooksPath .githooks; pre-commit 已调本脚本。

set -u

root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$(pwd)

# 扫 src/ 下的 .ts/.tsx (find -print0 + xargs -0, 文件名含空格也稳)。
# grep 无匹配返回 1 → 用 || true 让 set -u 下不退出; 真正的"命中"由下方判空。
hits=$(find "$root/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 2>/dev/null \
  | xargs -0 grep -nE 'onTouch(Start|End|Move|Cancel)\b|onMouse(Down|Up|Move)\b' 2>/dev/null \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' \
  || true)

if [ -n "$hits" ]; then
  cat <<'EOF'

────────────────────────────────────────────────────────────
✗ 移动端事件门: 检测到 onTouch*/onMouse* 手势 prop —— 用 Pointer Events 统一。

  onPointerDown / onPointerMove / onPointerUp / onPointerCancel 是 W3C 标准
  里打通鼠标 / 触摸 / 手写笔的那一层 (React 19 原生支持, 全浏览器 ≥97%)。
  onClick 在 <button> 上触摸设备只合成一次, 不会双触发; 而 onTouch*/onMouse*
  做手势要么双触发 (同时绑 touch+click), 要么漏掉另一类指针。

  改法: 把 onTouch*/onMouse* 换成对应的 onPointer*, 用 e.pointerType 区分
  指针类型, setPointerCapture 锁定指针流。参考 ui/Sheet.tsx 的 useDragDismiss。
────────────────────────────────────────────────────────────
EOF
  printf '%s\n' "$hits"
  exit 1
fi
