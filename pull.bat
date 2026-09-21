@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 從 GitHub 抓最新版到這台電腦...
git pull --rebase --autostash
pause
