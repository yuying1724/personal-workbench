@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 打包這台電腦的修改...
git add -A
git commit -m "更新 %date% %time%" >nul 2>&1
echo [2/3] 合併 GitHub 上的最新版（別台電腦推上去的修改）...
git pull --rebase
if errorlevel 1 (
  echo.
  echo 合併時發生衝突或錯誤，請把上面的訊息貼給 Claude。
  pause
  exit /b 1
)
echo [3/3] 上傳到 GitHub...
git push
if errorlevel 1 (
  echo.
  echo 上傳失敗，請把上面的訊息貼給 Claude。
  pause
  exit /b 1
)
echo.
echo 完成！大約一分鐘後網站就會更新。
pause
