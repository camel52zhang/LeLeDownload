@echo off
set PATH="D:\Program Files\nodejs";%PATH%
cd /d D:\tools\qlcaw\lele_download
npm.cmd install
echo Exit code: %ERRORLEVEL%
pause