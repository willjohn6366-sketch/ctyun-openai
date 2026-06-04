@echo off

set "targetPath=C:\Users\Administrator\.openclaw"

if not exist "%targetPath%" (
    echo [ERROR] Path not found: %targetPath%
    pause
    exit
)

setlocal enabledelayedexpansion

for %%f in ("%targetPath%\*") do (
    findstr /i /c:"openclaw" "%%f" >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=2 delims=:" %%v in ('findstr /i /c:"apiKey" "%%f" 2^>nul') do (
            set "val=%%v"
            set "val=!val:"=!"
            set "val=!val: =!"
            if not "!val!"=="" (
                echo %%~nxf
                echo   apiKey: !val!
                echo.
                echo.
                echo.
            )
        )
    )
)

endlocal
pause
