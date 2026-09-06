@echo off
REM Ouvre l'application via un serveur local (solution de secours).
cd /d "%~dp0"
start "" "http://localhost:8777/Notes%%20au%%20propre.html"
python -m http.server 8777
pause
