@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title 重启 dsh（加载 DSH 中转插件）

echo ============================================================
echo   重启 DeepSeek Harness 以加载 dsh-relay 插件
echo ============================================================
echo.
echo   为什么必须完全重启：
echo     插件在 dsh 启动时组装，运行中不会发现新插件。
echo     关窗口不算退出 —— Electron 会留在系统托盘里继续跑。
echo.
echo   本脚本会先杀掉所有 DeepSeek Harness 进程，再重新启动。
echo.
echo   注意：如果这个对话界面还开着，它也会被关掉。
echo         插件生效后重新打开即可。
echo.
pause

echo.
echo [1/3] 结束所有 DeepSeek Harness 进程...
taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1
if errorlevel 1 (
  echo       没有找到运行中的进程（可能已经退出了）
) else (
  echo       已结束
)
timeout /t 3 /nobreak >nul

echo.
echo [2/3] 确认端口已释放...
:waitport
netstat -ano | findstr ":19387" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       19387 仍被占用，再等 2 秒...
  timeout /t 2 /nobreak >nul
  goto waitport
)
echo       19387 已释放

echo.
echo [3/3] 启动 DeepSeek Harness...
if exist "F:\软件\dsh\DeepSeek Harness.exe" (
  start "" "F:\软件\dsh\DeepSeek Harness.exe"
  echo       已启动。等界面出来后再看设置。
) else (
  echo       [错误] 找不到 F:\软件\dsh\DeepSeek Harness.exe
  echo       请手工打开 DeepSeek Harness。
)

echo.
echo ============================================================
echo   启动后在哪里看
echo ============================================================
echo.
echo   1. 设置 ^-^> 插件 ^-^> 「DSH 中转」     ← 配置卡片（与 MiMo 视觉识别同一位置）
echo   2. 设置 ^-^> 「DSH 中转」              ← 同一份配置的独立整页
echo   3. 左下角角标   显示当前 dsh 端口 + 一键启停
echo.
echo   卡片里可改：启用开关 / 监听地址 / 监听端口 / 访问口令 / 强制回环改写
echo.
echo   若仍看不到卡片，运行：
echo     node "D:\数据\下载\引流网站\中转dsh\plugin\tools\diagnose.mjs"
echo.
pause
