@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem ============================================================
rem  一键启动：DSH Web + SnowLuma + qq-bridge
rem
rem  三个目录全部自动探测，不写死任何本机路径。
rem  探测顺序：
rem    1) 本脚本同目录下的 paths.cmd（想手动指定就建这个）
rem    2) 环境变量 DSH_HOME / SNOWLUMA_DIR / QQ_BRIDGE_DIR
rem    3) 在常用目录里自动找（Documents / Desktop / Downloads / 用户目录）
rem
rem  自动找不到时，在脚本旁边新建 paths.cmd，写：
rem    set "DSH_HOME=D:\somewhere\dsh-web-home"
rem    set "SNOWLUMA_DIR=D:\somewhere\SnowLuma"
rem    set "QQ_BRIDGE_DIR=D:\somewhere\qq-bridge"
rem ============================================================

rem ── 0. 允许同目录 paths.cmd 覆盖 ────────────────────────────
if exist "%~dp0paths.cmd" call "%~dp0paths.cmd"

rem ── 1. DSH_HOME ───────────────────────────────────────────
rem    环境变量若不是有效的 DSH 主目录（缺 profiles），先清掉再探测
if defined DSH_HOME if not exist "%DSH_HOME%\profiles" set "DSH_HOME="
if not defined DSH_HOME if exist "%USERPROFILE%\Documents\dsh-web-home\profiles" set "DSH_HOME=%USERPROFILE%\Documents\dsh-web-home"
if not defined DSH_HOME if exist "%USERPROFILE%\.dsh\profiles" set "DSH_HOME=%USERPROFILE%\.dsh"
if not defined DSH_HOME (
    for %%R in ("%USERPROFILE%\Documents" "%USERPROFILE%") do (
        if not defined DSH_HOME (
            for /f "delims=" %%D in ('dir /b /ad /o-d "%%~fR\dsh-*home" "%%~fR\.dsh" 2^>nul') do (
                if not defined DSH_HOME if exist "%%~fR\%%D\profiles" set "DSH_HOME=%%~fR\%%D"
            )
        )
    )
)

rem ── 2. SnowLuma（SnowLuma* 里取最新改动的）──────────────────
if not defined SNOWLUMA_DIR (
    for %%R in ("%USERPROFILE%\Documents" "%USERPROFILE%\Desktop" "%USERPROFILE%\Downloads" "%USERPROFILE%") do (
        if not defined SNOWLUMA_DIR (
            for /f "delims=" %%D in ('dir /b /ad /o-d "%%~fR\SnowLuma*" 2^>nul') do (
                if not defined SNOWLUMA_DIR if exist "%%~fR\%%D\index.mjs" set "SNOWLUMA_DIR=%%~fR\%%D"
            )
        )
    )
)

rem ── 3. qq-bridge ──────────────────────────────────────────
if not defined QQ_BRIDGE_DIR (
    for %%R in ("%USERPROFILE%\Documents" "%USERPROFILE%\Desktop" "%USERPROFILE%\Downloads" "%USERPROFILE%") do (
        if not defined QQ_BRIDGE_DIR if exist "%%~fR\qq-bridge\src\bridge.js" set "QQ_BRIDGE_DIR=%%~fR\qq-bridge"
    )
)

echo ============================================================
echo   DSH_HOME     : %DSH_HOME%
echo   SNOWLUMA_DIR : %SNOWLUMA_DIR%
echo   QQ_BRIDGE_DIR: %QQ_BRIDGE_DIR%
echo ============================================================
echo.

rem ── 4. 预检 ────────────────────────────────────────────────
where dsh >nul 2>&1
if errorlevel 1 (
    echo [错误] PATH 中找不到 dsh，请确认 pnpm\bin 在 PATH 中。
    pause
    exit /b 1
)
if not defined DSH_HOME (
    echo [错误] 没找到 DSH 数据目录（dsh-web-home 或 .dsh）。
    echo        可在脚本旁新建 paths.cmd 写：set "DSH_HOME=你的目录"
    pause
    exit /b 1
)
if not defined SNOWLUMA_DIR (
    echo [错误] 没找到 SnowLuma 目录（含 index.mjs 的 SnowLuma*）。
    echo        可在脚本旁新建 paths.cmd 写：set "SNOWLUMA_DIR=你的目录"
    pause
    exit /b 1
)
if not defined QQ_BRIDGE_DIR (
    echo [错误] 没找到 qq-bridge 目录（含 src\bridge.js）。
    echo        可在脚本旁新建 paths.cmd 写：set "QQ_BRIDGE_DIR=你的目录"
    pause
    exit /b 1
)

rem ── 5. DSH Web ─────────────────────────────────────────────
call :port_listening 3080
if not errorlevel 1 (
    echo DSH Web 已在 3080 监听，跳过启动。
) else (
    echo 正在启动 DSH Web...
    start "DSH Web" /D "%DSH_HOME%" cmd /k "chcp 65001 >nul & dsh web --host 127.0.0.1 --port 3080"
    echo 等待 DSH Web 就绪（端口 3080）...
    call :wait_port 3080 60
    if errorlevel 1 (
        echo [警告] 60 秒内未监听 3080，请查看 "DSH Web" 窗口的报错。
    ) else (
        echo DSH Web 已就绪。
    )
)

rem ── 6. SnowLuma ────────────────────────────────────────────
call :port_listening 5099
if not errorlevel 1 (
    echo SnowLuma 已在运行，跳过启动。
) else (
    echo 正在启动 SnowLuma...
    start "SnowLuma" /D "%SNOWLUMA_DIR%" cmd /k "chcp 65001 >nul & node .\check-node-version.cjs && node ./index.mjs || pause"
    echo 等待 SnowLuma 就绪（端口 5099）...
    call :wait_port 5099 90
    if errorlevel 1 (
        echo [警告] 90 秒内未监听 5099；bridge 会自动重试，不影响启动。
    ) else (
        echo SnowLuma 已就绪。
    )
)

rem ── 7. bridge（前台循环，关窗即停）──────────────────────────
cd /d "%QQ_BRIDGE_DIR%"
:loop
echo.
echo [%date% %time%] 启动 bridge...
node src/bridge.js
set code=%errorlevel%

if "%code%"=="2" (
    echo [%date% %time%] bridge 已在另一个窗口运行，退出。
    timeout /t 3 /nobreak >nul
    exit /b 2
)

echo [%date% %time%] bridge 已退出（code %code%），5 秒后重启...
timeout /t 5 /nobreak >nul
goto loop

rem ── 工具子程序 ─────────────────────────────────────────────
:port_listening
netstat -ano -p tcp | findstr /r /c:":%~1 .*LISTENING" >nul
exit /b %errorlevel%

:wait_port
set /a _n=0
:wait_loop
call :port_listening %~1
if not errorlevel 1 exit /b 0
set /a _n+=1
if %_n% gtr %~2 exit /b 1
timeout /t 1 /nobreak >nul
goto wait_loop
