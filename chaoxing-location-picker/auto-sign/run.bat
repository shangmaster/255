@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem  Batch files are parsed with the OEM/ACP codepage, so keep this file ASCII-only.
rem  All Chinese text below comes from python (sign.py), which we force to UTF-8.

set "PY="
where python.exe >nul 2>nul && set "PY=python.exe"
if not defined PY where py.exe >nul 2>nul && set "PY=py.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"

if not defined PY (
  echo [ERROR] Python not found.
  echo         Install Python 3.9+ from python.org and tick "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "ACT=%~1"
if /i "%ACT%"=="status"    goto do_status
if /i "%ACT%"=="test"      goto do_test
if /i "%ACT%"=="courses"   goto do_courses
if /i "%ACT%"=="install"   goto do_install
if /i "%ACT%"=="uninstall" goto do_uninstall
if /i "%ACT%"=="daemon"    goto do_daemon

:menu
cls
echo ==================================================
echo   Chaoxing auto sign-in  (location checkin only)
echo ==================================================
echo.
"%PY%" sign.py --status
echo.
echo --------------------------------------------------
echo   1. Refresh status          5. Fetch course list
echo   2. Run once now (test)     6. Install autostart
echo   3. Set time window         7. Remove autostart
echo   4. Set start coordinate    0. Exit
echo --------------------------------------------------
set "CH="
set /p CH=Select: 
if "%CH%"=="1" goto menu
if "%CH%"=="2" goto do_test
if "%CH%"=="3" goto do_time
if "%CH%"=="4" goto do_point
if "%CH%"=="5" goto do_courses
if "%CH%"=="6" goto do_install
if "%CH%"=="7" goto do_uninstall
if "%CH%"=="0" goto :eof
goto menu

:do_status
"%PY%" sign.py --status
goto done

:do_test
"%PY%" sign.py --once
goto done

:do_courses
"%PY%" sign.py --list-courses
goto done

:do_install
"%PY%" sign.py --install
goto done

:do_uninstall
"%PY%" sign.py --uninstall
goto done

:do_daemon
"%PY%" sign.py --daemon
goto done

:do_time
set "T1="
set "T2="
set /p T1=Start time (e.g. 08:00): 
set /p T2=End time   (e.g. 14:00): 
"%PY%" sign.py --set "start_time=%T1%" --set "end_time=%T2%"
goto done

:do_point
set "P1="
set /p P1=Start coordinate (lat,lon e.g. 38.0412,114.5123): 
"%PY%" sign.py --set "point=%P1%"
goto done

:done
echo.
pause
goto menu
