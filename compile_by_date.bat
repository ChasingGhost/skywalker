@echo off
rem Double-click to compile E:\DJI\Recent vids into one MP4 per date.
cd /d "%~dp0"
python compile_by_date.py %*
pause
