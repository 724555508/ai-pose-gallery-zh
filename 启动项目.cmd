@echo off
setlocal
chcp 65001 >nul
title AI 角色合成工作台
pushd "%~dp0"
if errorlevel 1 goto directory_error

echo 正在检查本地服务...
powershell.exe -NoProfile -Command "try { $q = Invoke-RestMethod -Uri 'http://localhost:5173/api/local-queue' -TimeoutSec 2; if ($q.PSObject.Properties.Name -contains 'jobs') { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 goto check_node
echo 服务已在运行，正在打开网页。
start "" "http://localhost:5173/studio"
goto done

:check_node
where node.exe >nul 2>&1
if errorlevel 1 goto node_missing
node.exe -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0]>22 || (v[0]===22 && v[1]>=15) ? 0 : 1)"
if errorlevel 1 goto node_old

if exist "node_modules\.bin\vite.cmd" goto launch
echo 首次启动，正在安装依赖，请保持网络连接...
where pnpm.cmd >nul 2>&1
if errorlevel 1 goto install_with_npx
call pnpm.cmd install --frozen-lockfile
if errorlevel 1 goto install_error
goto launch

:install_with_npx
where npx.cmd >nul 2>&1
if errorlevel 1 goto npm_missing
call npx.cmd --yes pnpm@11.25.0 install --frozen-lockfile
if errorlevel 1 goto install_error

:launch
if not exist "node_modules\.bin\vite.cmd" goto install_error
echo.
echo 正在启动：http://localhost:5173/studio
echo 内网其他机器请使用本机内网 IP 访问 5173 端口。
echo 请保持此窗口打开，队列会在后台逐个执行。
echo 关闭此窗口或按 Ctrl+C 将停止本地服务。ComfyUI 需要另外启动。
echo.
call "node_modules\.bin\vite.cmd" --host 0.0.0.0 --port 5173 --strictPort --open http://localhost:5173/studio
if errorlevel 1 goto launch_error
goto done

:node_missing
echo 未找到 Node.js。请安装 Node.js 22.15 或更高版本后重新双击此脚本。
goto failed
:node_old
echo Node.js 版本过低，请升级到 22.15 或更高版本。
goto failed
:npm_missing
echo 未找到 pnpm 或 npx。请修复 Node.js / npm 安装后重试。
goto failed
:install_error
echo 依赖安装失败，请检查上面的错误信息和网络连接。
goto failed
:launch_error
echo 启动失败。请查看上面的错误信息。
echo 如果端口被占用或已有队列服务运行，请使用原窗口，或先关闭原窗口再重试。
goto failed
:directory_error
echo 无法进入项目目录，请确认脚本仍放在项目根目录。
pause
exit /b 1
:failed
echo.
pause
popd
exit /b 1
:done
popd
endlocal
