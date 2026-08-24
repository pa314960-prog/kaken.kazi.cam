@echo off
REM このファイルをダブルクリックすると、このフォルダを簡易サーバーで公開します。
REM ブラウザで http://localhost:8000 を開いてください。
REM Pythonがインストールされていない場合はエラーが出ます。その場合はREADME.mdの
REM 「GitHub Pagesで公開する方法」を使ってください(インストール不要です)。

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Python でローカルサーバーを起動します。 http://localhost:8000 を開いてください。
    python -m http.server 8000
) else (
    echo Python が見つかりませんでした。
    echo README.md の「GitHub Pagesで公開する方法」を試してください。
    pause
)
